"""Conservative faceted solid from a closed mesh, with new scale parameters.

This retains the source facets and does not recover CAD surfaces or feature
history. Coplanar faces are merged only if the resulting solid remains valid
and preserves volume and bounds. No mesh repair or decimation is performed.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import math
from pathlib import Path
import tempfile
import threading

import cadquery as cq
import numpy as np
import trimesh
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_GTransform,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakePolygon,
    BRepBuilderAPI_MakeSolid,
    BRepBuilderAPI_Sewing,
)
from OCP.BRepBndLib import BRepBndLib
from OCP.Bnd import Bnd_Box
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.TopAbs import TopAbs_SHELL
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.gp import gp_GTrsf, gp_Mat, gp_Pnt, gp_XYZ

from backend.operations import apply_operations

MAX_SOLID_TRIANGLES = 25_000
MAX_REFERENCE_VERTICES = 75_000
_CACHE_SIZE = 3
_LOCK = threading.RLock()


@dataclass
class _Base:
    shape: cq.Shape
    vertices: np.ndarray
    faces: np.ndarray
    bounds: np.ndarray
    volume: float


_BASE_CACHE: OrderedDict[str, _Base] = OrderedDict()


def _reference(spec: dict) -> tuple[str, np.ndarray, np.ndarray]:
    if not isinstance(spec, dict) or spec.get("kind") != "mesh":
        raise ValueError("Se requiere una referencia de malla para convertir a sólido faceteado.")
    if "transform" in spec:
        raise ValueError("La malla ya incluye su posición; no admite una transformación adicional.")
    reference = spec.get("reference")
    if not isinstance(reference, dict):
        raise ValueError("Falta la malla de referencia original.")
    try:
        vertices = np.asarray(reference.get("vertices"), dtype=np.float64)
        raw_faces = np.asarray(reference.get("faces"))
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError("La malla de referencia contiene coordenadas o índices inválidos.") from exc
    if (vertices.ndim != 2 or vertices.shape[1] != 3
            or not 4 <= len(vertices) <= MAX_REFERENCE_VERTICES):
        raise ValueError("La referencia debe contener entre 4 y 75.000 vértices de tres coordenadas.")
    if raw_faces.ndim != 2 or raw_faces.shape[1] != 3 or len(raw_faces) < 4:
        raise ValueError("La referencia debe contener al menos cuatro caras triangulares.")
    if len(raw_faces) > MAX_SOLID_TRIANGLES:
        raise ValueError("La conversión a sólido admite hasta 25.000 triángulos; esta malla solo se puede visualizar.")
    if (not np.issubdtype(raw_faces.dtype, np.integer)
            or np.issubdtype(raw_faces.dtype, np.bool_)):
        raise ValueError("Los índices de las caras deben ser números enteros.")
    faces = np.asarray(raw_faces, dtype=np.int64)
    if faces.min() < 0 or faces.max() >= len(vertices):
        raise ValueError("Una cara referencia un vértice que no existe.")
    if not np.isfinite(vertices).all():
        raise ValueError("La malla contiene coordenadas no finitas.")
    if np.max(np.abs(vertices)) > 1_000_000:
        raise ValueError("Las coordenadas exceden 1.000.000 mm; revisa las unidades.")
    # Unreferenced points must not influence the scale centre or source bounds.
    used, remapped = np.unique(faces, return_inverse=True)
    vertices = np.ascontiguousarray(vertices[used], dtype=np.float64)
    faces = np.ascontiguousarray(remapped.reshape((-1, 3)), dtype=np.int64)
    spans = np.ptp(vertices, axis=0)
    if spans.min() < 1e-6 or spans.max() > 100_000:
        raise ValueError("El tamaño de la referencia no permite construir un sólido; revisa las unidades.")
    digest = hashlib.sha256(vertices.tobytes() + faces.tobytes()).hexdigest()
    return digest, vertices, faces


def _bounds(shape: cq.Shape) -> np.ndarray:
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape.wrapped, box, False, False)
    return np.asarray(box.Get(), dtype=float).reshape((2, 3))


def _valid(shape: cq.Shape, expected_volume: float, expected_bounds: np.ndarray) -> bool:
    try:
        volume = float(shape.Volume())
        return bool(shape.isValid() and len(shape.Solids()) == 1
                    and math.isfinite(volume) and volume > 0
                    and math.isclose(volume, expected_volume, rel_tol=1e-7, abs_tol=1e-8)
                    and np.allclose(_bounds(shape), expected_bounds, rtol=0, atol=1e-6))
    except Exception:
        return False


def _get_base(key: str, vertices: np.ndarray, faces: np.ndarray) -> _Base:
    if key in _BASE_CACHE:
        _BASE_CACHE.move_to_end(key)
        return _BASE_CACHE[key]
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    if not mesh.is_watertight:
        raise ValueError("La malla debe estar cerrada y ser manifold para convertirla a sólido.")
    if not mesh.is_winding_consistent:
        raise ValueError("La orientación de las caras es inconsistente; revisa el STL original.")
    if mesh.body_count != 1:
        raise ValueError("La conversión requiere una sola pieza conectada.")
    if np.any(mesh.area_faces <= max(1e-16, float(np.ptp(vertices, axis=0).max()) ** 2 * 1e-14)):
        raise ValueError("La malla contiene triángulos degenerados.")
    signed_volume = float(mesh.volume)
    if not math.isfinite(signed_volume) or abs(signed_volume) < 1e-12:
        raise ValueError("La malla no delimita un volumen válido.")
    if signed_volume < 0:
        # Global orientation only: same triangles, vertices and geometry.
        faces = np.ascontiguousarray(faces[:, ::-1])
    volume = abs(signed_volume)
    bounds = np.vstack((vertices.min(axis=0), vertices.max(axis=0)))
    try:
        sewing = BRepBuilderAPI_Sewing(1e-7)
        for triangle in vertices[faces]:
            polygon = BRepBuilderAPI_MakePolygon()
            for point in triangle:
                polygon.Add(gp_Pnt(*point))
            polygon.Close()
            sewing.Add(BRepBuilderAPI_MakeFace(polygon.Wire()).Face())
        sewing.Perform()
        explorer = TopExp_Explorer(sewing.SewedShape(), TopAbs_SHELL)
        shells = []
        while explorer.More():
            shells.append(TopoDS.Shell_s(explorer.Current()))
            explorer.Next()
        if len(shells) != 1:
            raise ValueError("No se pudo coser la malla en una única envolvente cerrada.")
        shape = cq.Shape.cast(BRepBuilderAPI_MakeSolid(shells[0]).Solid())
        if not _valid(shape, volume, bounds):
            raise ValueError("La malla no produce un sólido CAD válido sin reparar su geometría.")
        # Strict tolerances avoid merging almost coplanar facets. Validation
        # rejects any simplification that changes the solid's measurable shape.
        try:
            unifier = ShapeUpgrade_UnifySameDomain(shape.wrapped, True, True, False)
            unifier.SetLinearTolerance(1e-9)
            unifier.SetAngularTolerance(1e-12)
            unifier.Build()
            candidate = cq.Shape.cast(unifier.Shape())
            if _valid(candidate, volume, bounds):
                shape = candidate
        except Exception:
            pass  # The original, validated faceted solid remains available.
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("No se pudo convertir esta malla a un sólido faceteado válido.") from exc
    vertices.setflags(write=False)
    faces.setflags(write=False)
    result = _Base(shape, vertices, faces, bounds, volume)
    _BASE_CACHE[key] = result
    _BASE_CACHE.move_to_end(key)
    while len(_BASE_CACHE) > _CACHE_SIZE:
        _BASE_CACHE.popitem(last=False)
    return result


def _scaled(spec: dict) -> tuple[cq.Shape, np.ndarray, np.ndarray]:
    key, vertices, faces = _reference(spec)
    parameters = spec.get("parameters")
    if not isinstance(parameters, dict):
        raise ValueError("Faltan los parámetros de ancho, fondo y altura.")
    if set(parameters) != {"width", "depth", "height"}:
        raise ValueError("El sólido faceteado solo admite ancho, fondo y altura; no recupera parámetros de agujeros.")
    dimensions = []
    for name in ("width", "depth", "height"):
        value = parameters.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= 100_000 or not math.isfinite(value):
            raise ValueError("Ancho, fondo y altura deben ser números positivos de hasta 100.000 mm.")
        dimensions.append(float(value))
    factors = np.asarray(dimensions) / np.ptp(vertices, axis=0)
    if np.any(factors < 1e-3) or np.any(factors > 1e3):
        raise ValueError("La escala debe estar entre 0,001 y 1.000 veces el tamaño original.")
    base = _get_base(key, vertices, faces)
    centre = base.bounds.mean(axis=0)
    scaled_vertices = (base.vertices - centre) * factors + centre
    target_bounds = np.vstack((scaled_vertices.min(axis=0), scaled_vertices.max(axis=0)))
    try:
        if np.array_equal(factors, np.ones(3)):
            shape = base.shape
        else:
            transform = gp_GTrsf()
            transform.SetVectorialPart(gp_Mat(float(factors[0]), 0., 0.,
                                              0., float(factors[1]), 0.,
                                              0., 0., float(factors[2])))
            transform.SetTranslationPart(gp_XYZ(*((1 - factors) * centre)))
            shape = cq.Shape.cast(BRepBuilderAPI_GTransform(base.shape.wrapped, transform, True).Shape())
        if not _valid(shape, base.volume * float(np.prod(factors)), target_bounds):
            raise ValueError("Estas dimensiones no producen un sólido válido; reduce el cambio de escala.")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("No se pudo aplicar la escala al sólido faceteado.") from exc
    return shape, scaled_vertices, base.faces


def mesh_preview(spec: dict) -> dict:
    """Retain source facets until new operations require CAD tessellation."""
    with _LOCK:
        shape, vertices, faces = _scaled(spec)
        shape = apply_operations(shape, spec.get("operations", []))
        if spec.get("operations"):
            points, triangles = shape.tessellate(.04, angularTolerance=.1)
            return {"mesh": {"vertices": [[v.x, v.y, v.z] for v in points],
                             "faces": [list(face) for face in triangles]},
                    "volume": float(shape.Volume(tol=1e-8)), "faces": len(shape.Faces()), "valid": True}
        return {"mesh": {"vertices": vertices.tolist(), "faces": faces.tolist()},
                "volume": float(shape.Volume()), "faces": len(shape.Faces()), "valid": True}


def mesh_export_step(spec: dict) -> bytes:
    """Export a valid faceted STEP solid, without claiming recovered history."""
    with _LOCK:
        shape, _, _ = _scaled(spec)
        shape = apply_operations(shape, spec.get("operations", []))
        with tempfile.TemporaryDirectory(prefix="edu3d-faceted-step-") as directory:
            path = Path(directory) / "solido-faceteado.step"
            try:
                cq.exporters.export(shape, str(path), exportType="STEP")
                return path.read_bytes()
            except Exception as exc:
                raise ValueError("No se pudo exportar el sólido faceteado a STEP.") from exc


def mesh_export_stl(spec: dict) -> bytes:
    with _LOCK:
        shape, vertices, faces = _scaled(spec)
        shape = apply_operations(shape, spec.get("operations", []))
        if spec.get("operations"):
            with tempfile.TemporaryDirectory(prefix="edu3d-operated-stl-") as directory:
                path = Path(directory) / "pieza-editada.stl"
                try:
                    if not shape.exportStl(str(path), tolerance=.02, angularTolerance=.08,
                                           relative=False, parallel=False):
                        raise ValueError("No se pudo exportar el sólido editado a STL.")
                    return path.read_bytes()
                except ValueError:
                    raise
                except Exception as exc:
                    raise ValueError("No se pudo exportar el sólido editado a STL.") from exc
        return trimesh.exchange.stl.export_stl(trimesh.Trimesh(vertices=vertices, faces=faces, process=False))
