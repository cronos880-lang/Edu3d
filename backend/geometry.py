"""STL inspection and conservative reconstruction of simple analytic solids.

STL contains triangles, not a CAD feature history. Recognition in this module
only proposes an editable primitive when its complete mesh supports that model.
Dimensions and exported STEP coordinates are always millimetres.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import re
import struct
import tempfile

import cadquery as cq
import numpy as np
from OCP.gp import gp_Trsf
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from backend.operations import apply_operations


MAX_STL_BYTES = 20 * 1024 * 1024
MAX_TRIANGLES = 250_000
UNIT_SCALES = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4, "inch": 25.4}


@dataclass
class STLMesh:
    """Welded, millimetre mesh; no user-supplied facet normals are trusted."""

    vertices: np.ndarray
    faces: np.ndarray
    normals: np.ndarray
    areas: np.ndarray
    watertight: bool
    consistent: bool
    components: int
    volume: float | None
    warnings: list[str]


def _component_labels(faces: np.ndarray, vertex_count: int) -> tuple[int, np.ndarray]:
    active = np.unique(faces)
    edges = np.concatenate((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]))
    graph = coo_matrix((np.ones(len(edges)), (edges[:, 0], edges[:, 1])),
                       shape=(vertex_count, vertex_count)).tocsr()
    _, labels = connected_components(graph, directed=False)
    used = labels[active]
    count, remapped = np.unique(used, return_inverse=True)
    result = np.full(vertex_count, -1, dtype=np.int64)
    result[active] = remapped
    return len(count), result


def load_stl(data: bytes, units: str = "mm") -> STLMesh:
    """Read binary/ASCII STL, validate bounds and weld duplicate vertices.

    Defective topology remains inspectable, but is never reconstructed.
    Malformed files, nonfinite coordinates and resource limits raise ValueError.
    """
    if not isinstance(units, str) or units not in UNIT_SCALES:
        raise ValueError("Unidad desconocida. Usa mm, cm, m o in.")
    if not isinstance(data, bytes) or not data:
        raise ValueError("El archivo STL está vacío.")
    if len(data) > MAX_STL_BYTES:
        raise ValueError("El STL supera el límite de 20 MiB.")
    binary_count = struct.unpack_from("<I", data, 80)[0] if len(data) >= 84 else 0
    if len(data) >= 84 and 84 + binary_count * 50 == len(data):
        if not 1 <= binary_count <= MAX_TRIANGLES:
            raise ValueError("El STL debe contener entre 1 y 250.000 triángulos.")
        dtype = np.dtype([("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")])
        triangles = np.frombuffer(data, dtype=dtype, count=binary_count, offset=84)["vertices"].astype(float)
    else:
        try:
            text = data.decode("ascii")
        except UnicodeDecodeError as exc:
            raise ValueError("STL binario incompleto o formato no reconocido.") from exc
        # Parse complete standard facets. Reject stray vertices/truncated facets.
        number = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
        vertex = rf"vertex\s+({number})\s+({number})\s+({number})"
        values = re.findall(vertex, text, re.IGNORECASE)
        facets = len(re.findall(r"\bendfacet\b", text, re.IGNORECASE))
        if (not values or len(values) % 3 or facets != len(values) // 3
                or len(re.findall(r"\bvertex\b", text, re.IGNORECASE)) != len(values)):
            raise ValueError("El STL ASCII está incompleto o contiene coordenadas inválidas.")
        if facets > MAX_TRIANGLES:
            raise ValueError("El STL supera el límite de 250.000 triángulos.")
        triangles = np.asarray(values, dtype=float).reshape((-1, 3, 3))
    triangles *= UNIT_SCALES[units]
    if not np.isfinite(triangles).all():
        raise ValueError("El STL contiene coordenadas no finitas.")
    if np.max(np.abs(triangles)) > 1_000_000:
        raise ValueError("Las coordenadas del STL exceden 1.000.000 mm; revisa las unidades.")
    span = float(np.max(np.ptp(triangles.reshape((-1, 3)), axis=0)))
    if span < 1e-6 or span > 100_000:
        raise ValueError("El tamaño de la pieza no es válido; revisa las unidades del STL.")
    weld_tolerance = max(1e-8, span * 1e-8)
    points = triangles.reshape((-1, 3))
    _, first, inverse = np.unique(np.rint(points / weld_tolerance).astype(np.int64), axis=0,
                                  return_index=True, return_inverse=True)
    vertices = points[first]
    faces = inverse.reshape((-1, 3))
    cross = np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]],
                     vertices[faces[:, 2]] - vertices[faces[:, 0]])
    lengths = np.linalg.norm(cross, axis=1)
    good = lengths > max(1e-16, span * span * 1e-14)
    normals = np.divide(cross, lengths[:, None], out=np.zeros_like(cross), where=lengths[:, None] > 0)
    edges = np.concatenate((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]))
    sorted_edges = np.sort(edges, axis=1)
    _, edge_inverse, edge_counts = np.unique(sorted_edges, axis=0, return_inverse=True, return_counts=True)
    edge_directions = np.where(edges[:, 0] < edges[:, 1], 1, -1)
    orientation = np.bincount(edge_inverse, weights=edge_directions)
    watertight = bool(good.all() and np.all(edge_counts == 2))
    consistent = bool(np.all(orientation == 0))
    components, _ = _component_labels(faces, len(vertices))
    warnings = []
    if not good.all():
        warnings.append("La malla contiene triángulos degenerados.")
    if not watertight:
        warnings.append("La malla no es cerrada y manifold; no se puede reconstruir de forma fiable.")
    if watertight and not consistent:
        warnings.append("La orientación de las caras es inconsistente.")
    if components != 1:
        warnings.append(f"El archivo contiene {components} cuerpos separados; se requiere una sola pieza.")
    volume = None
    if watertight and consistent:
        centered = vertices - vertices.mean(axis=0)
        volume = float(abs(np.einsum("ij,ij->i", centered[faces[:, 0]],
                           np.cross(centered[faces[:, 1]], centered[faces[:, 2]])).sum() / 6.0))
    return STLMesh(vertices, faces, normals, lengths / 2, watertight, consistent,
                   components, volume, warnings)


def _canonical_axis(vector: np.ndarray) -> np.ndarray:
    axis = vector / np.linalg.norm(vector)
    return -axis if axis[np.argmax(np.abs(axis))] < 0 else axis


def _normal_candidates(mesh: STLMesh) -> list[np.ndarray]:
    normals = mesh.normals.copy()
    major = np.argmax(np.abs(normals), axis=1)
    signs = np.where(normals[np.arange(len(normals)), major] < 0, -1, 1)
    normals *= signs[:, None]
    _, inverse = np.unique(np.round(normals, 4), axis=0, return_inverse=True)
    weights = np.bincount(inverse, weights=mesh.areas)
    # Tiny sliver triangles have noisy normals after float32 STL export. An
    # area-weighted plane normal keeps an arbitrary first facet from tilting
    # the reconstructed cylinder/plate and changing its dimensions.
    sums = np.column_stack([np.bincount(inverse, weights=mesh.areas * normals[:, i]) for i in range(3)])
    counts = np.bincount(inverse)
    # A very tall, narrow cylinder has tiny caps but many coplanar cap facets.
    # Include count-ranked groups so area ranking cannot hide its axis.
    indices = list(dict.fromkeys([*np.argsort(weights)[::-1][:12], *np.argsort(counts)[::-1][:6]]))
    return [_canonical_axis(sums[i]) for i in indices if weights[i] > 0]


def _transform(x: np.ndarray, y: np.ndarray, z: np.ndarray, origin: np.ndarray) -> list[list[float]]:
    matrix = np.eye(4)
    matrix[:3, :3] = np.column_stack((x, y, z))
    matrix[:3, 3] = origin
    return matrix.tolist()


def _recognize_box(mesh: STLMesh, candidates: list[np.ndarray], tolerance: float) -> dict | None:
    for z0 in sorted(candidates, key=lambda n: abs(n[2]), reverse=True):
        z = _canonical_axis(z0)
        for x0 in sorted(candidates, key=lambda n: abs(n[0]), reverse=True):
            if abs(np.dot(x0, z)) > 1e-4:
                continue
            x = _canonical_axis(x0 - np.dot(x0, z) * z)
            y = np.cross(z, x)
            basis = np.column_stack((x, y, z))
            alignment = np.abs(mesh.normals @ basis)
            if np.any(alignment.max(axis=1) < 1 - 1e-6):
                continue
            projected = mesh.vertices @ basis
            low, high = projected.min(axis=0), projected.max(axis=0)
            dimensions = high - low
            if dimensions.min() <= tolerance:
                continue
            triangles = projected[mesh.faces]
            # Each triangle must lie on one of the six bounding planes.
            plane_error = np.minimum(np.max(np.abs(triangles - low), axis=1),
                                     np.max(np.abs(triangles - high), axis=1)).min(axis=1)
            if plane_error.max() > tolerance:
                continue
            expected_volume = float(np.prod(dimensions))
            if abs(mesh.volume - expected_volume) > max(tolerance ** 3, expected_volume * .001):
                continue
            origin = basis @ np.array([(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, low[2]])
            return {"kind": "box", "parameters": dict(zip(("width", "depth", "height"), dimensions.tolist())),
                    "transform": _transform(x, y, z, origin), "error_mm": float(plane_error.max()),
                    "description": "Caja reconstruida a partir de seis planos ortogonales cerrados."}
    return None


def _fit_circle(points: np.ndarray, tolerance: float) -> tuple[np.ndarray, float, float] | None:
    points = np.unique(np.round(points, 8), axis=0)
    if len(points) < 18:
        return None
    mean = points.mean(axis=0)
    shifted = points - mean
    matrix = np.column_stack((2 * shifted, np.ones(len(points))))
    solution, _, rank, _ = np.linalg.lstsq(matrix, np.sum(shifted ** 2, axis=1), rcond=None)
    if rank != 3:
        return None
    center = mean + solution[:2]
    distances = np.linalg.norm(points - center, axis=1)
    radius = float(distances.mean())
    residual = float(np.max(np.abs(distances - radius)))
    if radius <= tolerance or residual > tolerance:
        return None
    angles = np.sort(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]))
    max_angle = float(np.diff(np.r_[angles, angles[0] + 2 * math.pi]).max())
    # Coarse polygonal prisms do not provide enough evidence for a circle.
    if max_angle > math.radians(21):
        return None
    return center, radius, residual + radius * (1 - math.cos(max_angle / 2))


def _rectangle_side(mesh: STLMesh, face_ids: np.ndarray, axis: np.ndarray,
                    tolerance: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, float] | None:
    normals = mesh.normals[face_ids]
    for normal in sorted(normals[:min(len(normals), 1000)], key=lambda n: abs(n[0]), reverse=True):
        x = _canonical_axis(normal - np.dot(normal, axis) * axis)
        y = np.cross(axis, x)
        if np.any(np.maximum(np.abs(normals @ x), np.abs(normals @ y)) < 1 - 1e-6):
            continue
        ids = np.unique(mesh.faces[face_ids])
        basis = np.column_stack((x, y))
        points = mesh.vertices[ids] @ basis
        low, high = points.min(axis=0), points.max(axis=0)
        triangles = mesh.vertices[mesh.faces[face_ids]] @ basis
        error = np.minimum(np.max(np.abs(triangles - low), axis=1),
                           np.max(np.abs(triangles - high), axis=1)).min(axis=1)
        if np.max(error) <= tolerance and np.min(high - low) > tolerance:
            return x, y, low, high, float(error.max())
    return None


def _recognize_extrusion(mesh: STLMesh, axis: np.ndarray, tolerance: float) -> dict | None:
    z = _canonical_axis(axis)
    heights = mesh.vertices @ z
    bottom, top = float(heights.min()), float(heights.max())
    height = top - bottom
    if height <= tolerance:
        return None
    dots = np.abs(mesh.normals @ z)
    cap = dots > 1 - 1e-6
    side = dots < 1e-5
    if not cap.any() or not side.any() or np.any(~(cap | side)):
        return None
    cap_heights = heights[mesh.faces[cap]]
    if np.any(np.minimum(np.max(np.abs(cap_heights - bottom), axis=1),
                         np.max(np.abs(cap_heights - top), axis=1)) > tolerance):
        return None
    if not (np.any(np.max(np.abs(cap_heights - bottom), axis=1) < tolerance)
            and np.any(np.max(np.abs(cap_heights - top), axis=1) < tolerance)):
        return None
    side_ids = np.flatnonzero(side)
    count, labels = _component_labels(mesh.faces[side], len(mesh.vertices))
    if count not in (1, 2):
        return None
    reference = np.array([1., 0., 0.]) if abs(z[0]) < .9 else np.array([0., 1., 0.])
    x = _canonical_axis(reference - np.dot(reference, z) * z)
    y = np.cross(z, x)
    basis = np.column_stack((x, y))
    circles, rectangles = [], []
    for label in range(count):
        group_faces = side_ids[labels[mesh.faces[side, 0]] == label]
        ids = np.unique(mesh.faces[group_faces])
        if abs(float(heights[ids].min()) - bottom) > tolerance or abs(float(heights[ids].max()) - top) > tolerance:
            return None
        circle = _fit_circle(mesh.vertices[ids] @ basis, tolerance)
        if circle is not None:
            circles.append(circle)
        else:
            rectangle = _rectangle_side(mesh, group_faces, z, tolerance)
            if rectangle is None:
                return None
            rectangles.append(rectangle)
    if len(circles) == count:
        circles.sort(key=lambda item: item[1], reverse=True)
        center, radius, error = circles[0]
        parameters = {"diameter": radius * 2, "height": height}
        kind = "cylinder"
        expected = math.pi * radius * radius * height
        if count == 2:
            inner_center, inner_radius, inner_error = circles[1]
            if np.linalg.norm(center - inner_center) > tolerance or radius - inner_radius <= tolerance:
                return None
            parameters["inner_diameter"] = inner_radius * 2
            kind = "tube"
            expected -= math.pi * inner_radius * inner_radius * height
            error = max(error, inner_error)
        origin = basis @ center + z * bottom
        description = "Tubo reconstruido con dos superficies cilíndricas concéntricas." if count == 2 else "Cilindro reconstruido con tapas planas y superficie lateral circular."
    elif len(circles) == 1 and len(rectangles) == 1:
        rx, ry, low, high, rect_error = rectangles[0]
        center, radius, error = circles[0]
        center_world = basis @ center
        hole = np.array([center_world @ rx, center_world @ ry])
        if np.any(hole - radius <= low + tolerance) or np.any(hole + radius >= high - tolerance):
            return None
        dimensions = high - low
        hole_relative = hole - (low + high) / 2
        parameters = {"width": float(dimensions[0]), "depth": float(dimensions[1]), "height": height,
                      "hole_diameter": radius * 2, "hole_x": float(hole_relative[0]), "hole_y": float(hole_relative[1])}
        expected = (float(np.prod(dimensions)) - math.pi * radius * radius) * height
        kind = "plate"
        x, y = rx, ry
        origin = rx * ((low[0] + high[0]) / 2) + ry * ((low[1] + high[1]) / 2) + z * bottom
        error = max(error, rect_error)
        description = "Placa rectangular reconstruida con un taladro circular pasante."
    else:
        return None
    if expected <= 0 or abs(mesh.volume - expected) > expected * .025:
        return None
    return {"kind": kind, "parameters": parameters, "transform": _transform(x, y, z, origin),
            "error_mm": float(error), "description": description}


def analyze_stl(data: bytes, units: str = "mm", name: str = "pieza.stl") -> dict:
    mesh = load_stl(data, units)
    warnings = list(mesh.warnings)
    dimensions = np.ptp(mesh.vertices, axis=0)
    recognition = None
    if mesh.watertight and mesh.consistent and mesh.components == 1 and mesh.volume > 1e-9:
        tolerance = max(2e-5, float(dimensions.max()) * 2e-5)
        candidates = _normal_candidates(mesh)
        recognition = _recognize_box(mesh, candidates, tolerance)
        if recognition is None:
            for axis in candidates:
                recognition = _recognize_extrusion(mesh, axis, tolerance)
                if recognition is not None:
                    break
    model = None
    if recognition:
        try:
            model = model_preview(recognition)
        except (ValueError, RuntimeError):
            recognition = None
            warnings.append("La reconstrucción no produjo un sólido CAD válido.")
    if recognition is None:
        warnings.append("No se ha reconocido una forma paramétrica sencilla. Puedes conservar la malla o crear un sólido de referencia; este no recupera el historial original.")
    else:
        warnings.append("La reconstrucción es una aproximación geométrica. STL no conserva el historial ni las restricciones del diseño original.")
    return {"name": str(name), "source_units": units,
            "mesh": {"vertices": mesh.vertices.tolist(), "faces": mesh.faces.tolist()},
            "analysis": {"watertight": mesh.watertight, "triangles": len(mesh.faces),
                         "dimensions": dimensions.tolist(), "volume": mesh.volume, "warnings": warnings},
            "recognition": recognition, "model": model}


_PARAMETERS = {"box": {"width", "depth", "height"}, "cylinder": {"diameter", "height"},
               "tube": {"diameter", "inner_diameter", "height"},
               "plate": {"width", "depth", "height", "hole_diameter", "hole_x", "hole_y"}}


def _validated_spec(spec: dict) -> tuple[str, dict, np.ndarray]:
    if not isinstance(spec, dict) or not isinstance(spec.get("kind"), str) or spec["kind"] not in _PARAMETERS:
        raise ValueError("Tipo de pieza no soportado. Usa box, cylinder, tube o plate.")
    kind = spec["kind"]
    parameters = spec.get("parameters")
    if not isinstance(parameters, dict) or set(parameters) != _PARAMETERS[kind]:
        required = ", ".join(sorted(_PARAMETERS[kind]))
        raise ValueError(f"Parámetros requeridos para {kind}: {required}.")
    values = {}
    for key, value in parameters.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"El parámetro {key} debe ser un número finito.")
        number = float(value)
        if key not in {"hole_x", "hole_y"} and not .01 <= number <= 100_000:
            raise ValueError(f"El parámetro {key} debe estar entre 0,01 y 100.000 mm.")
        if abs(number) > 100_000:
            raise ValueError(f"El parámetro {key} excede 100.000 mm.")
        values[key] = number
    if kind == "tube" and values["inner_diameter"] >= values["diameter"] - .01:
        raise ValueError("El diámetro interior debe ser menor que el exterior y dejar pared positiva.")
    if kind == "plate":
        radius = values["hole_diameter"] / 2
        if abs(values["hole_x"]) + radius >= values["width"] / 2 - .005 or abs(values["hole_y"]) + radius >= values["depth"] / 2 - .005:
            raise ValueError("El taladro debe quedar completamente dentro de la placa.")
    try:
        matrix = np.asarray(spec.get("transform", np.eye(4)), dtype=float)
    except (TypeError, ValueError) as exc:
        raise ValueError("La transformación debe ser una matriz rígida 4×4.") from exc
    if matrix.shape != (4, 4) or not np.isfinite(matrix).all():
        raise ValueError("La transformación debe ser una matriz finita 4×4.")
    rotation = matrix[:3, :3]
    if not np.allclose(matrix[3], [0, 0, 0, 1], atol=1e-8) or not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-6) or not math.isclose(np.linalg.det(rotation), 1, abs_tol=1e-6):
        raise ValueError("La transformación solo puede contener rotación y traslación; no escala ni reflexión.")
    if np.max(np.abs(matrix[:3, 3])) > 1_000_000:
        raise ValueError("La posición de la pieza excede 1.000.000 mm.")
    return kind, values, matrix


def build_model(spec: dict) -> cq.Shape:
    """Create one valid analytic B-rep; supplied feature history is explicit."""
    kind, p, matrix = _validated_spec(spec)
    try:
        workplane = cq.Workplane("XY")
        if kind in {"box", "plate"}:
            model = workplane.box(p["width"], p["depth"], p["height"], centered=(True, True, False))
            if kind == "plate":
                cutter = workplane.center(p["hole_x"], p["hole_y"]).circle(p["hole_diameter"] / 2).extrude(p["height"])
                model = model.cut(cutter)
        elif kind == "cylinder":
            model = workplane.circle(p["diameter"] / 2).extrude(p["height"])
        else:
            model = workplane.circle(p["diameter"] / 2).circle(p["inner_diameter"] / 2).extrude(p["height"])
        shape = model.val()
        if not np.allclose(matrix, np.eye(4), atol=1e-12):
            # gp_Trsf keeps analytic surfaces and avoids gp_GTrsf's form flag:
            # CadQuery Matrix(list).Trsf() may reject even a pure translation.
            transform = gp_Trsf()
            transform.SetValues(*matrix[:3, :].reshape(-1).tolist())
            shape = shape.moved(cq.Location(transform))
        if len(shape.Solids()) != 1 or not shape.isValid() or shape.Volume() <= 0:
            raise ValueError("Los parámetros no producen un único sólido CAD válido.")
        return apply_operations(shape, spec.get("operations"))
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("No se pudo construir la pieza con estos parámetros.") from exc


def _preview(shape: cq.Shape) -> dict:
    vertices, faces = shape.tessellate(.04, angularTolerance=.1)
    return {"mesh": {"vertices": [[v.x, v.y, v.z] for v in vertices],
                      "faces": [list(face) for face in faces]},
            "volume": float(shape.Volume()), "faces": len(shape.Faces()), "valid": bool(shape.isValid())}


def model_preview(spec: dict) -> dict:
    return _preview(build_model(spec))


def export_step(spec: dict) -> bytes:
    shape = build_model(spec)
    with tempfile.TemporaryDirectory(prefix="edu3d-step-") as directory:
        path = Path(directory) / "pieza.step"
        cq.exporters.export(shape, str(path), exportType="STEP")
        return path.read_bytes()


def export_stl(spec: dict) -> bytes:
    shape = build_model(spec)
    with tempfile.TemporaryDirectory(prefix="edu3d-stl-") as directory:
        path = Path(directory) / "pieza.stl"
        if not shape.exportStl(str(path), tolerance=.02, angularTolerance=.08, relative=False, parallel=False):
            raise ValueError("No se pudo exportar el archivo STL.")
        return path.read_bytes()


def demo_stl() -> bytes:
    """A small printable rectangular plate with one off-centre through-hole."""
    return export_stl({"kind": "plate", "parameters": {"width": 50, "depth": 32, "height": 5,
                      "hole_diameter": 8, "hole_x": 10, "hole_y": 0}})
