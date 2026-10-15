"""Faceted STEP must preserve a mesh solid and explicit new scale parameters."""
from copy import deepcopy
import math
from pathlib import Path
import tempfile

import cadquery as cq
import numpy as np
import pytest
import trimesh

from backend.mesh_solid import mesh_preview, mesh_export_step, mesh_export_stl


def cube_spec():
    mesh = trimesh.creation.box(extents=[20, 30, 10])
    mesh.apply_translation([40, -15, 6])
    return {"kind": "mesh", "reference": {"vertices": mesh.vertices.tolist(),
                                            "faces": mesh.faces.tolist()},
            "parameters": {"width": 24, "depth": 18, "height": 9}}


def test_scaled_mesh_step_roundtrip_preserves_valid_solid_volume_and_centre():
    spec = cube_spec()
    preview = mesh_preview(spec)
    assert preview["valid"]
    assert preview["volume"] == pytest.approx(24 * 18 * 9)
    vertices = np.asarray(preview["mesh"]["vertices"])
    assert np.ptp(vertices, axis=0) == pytest.approx([24, 18, 9])
    assert (vertices.min(axis=0) + vertices.max(axis=0)) / 2 == pytest.approx([40, -15, 6])
    assert preview["faces"] == 6  # Only exactly coplanar triangles are merged.
    exported = mesh_export_step(spec)
    assert exported.startswith(b"ISO-10303-21;")
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "faceted.step"
        path.write_bytes(exported)
        restored = cq.importers.importStep(str(path)).val()
    assert restored.isValid() and len(restored.Solids()) == 1
    assert restored.Volume() == pytest.approx(3888, rel=1e-8)
    assert restored.Center().toTuple() == pytest.approx([40, -15, 6])
    box = restored.BoundingBox()
    assert [box.xlen, box.ylen, box.zlen] == pytest.approx([24, 18, 9], abs=1e-5)
    stl = trimesh.load_mesh(__import__("io").BytesIO(mesh_export_stl(spec)), file_type="stl")
    assert stl.is_watertight and stl.volume == pytest.approx(3888, rel=1e-6)
    # Editing new dimensions reuses the reference, rather than scaling prior edits.
    edited = deepcopy(spec)
    edited["parameters"]["width"] = 30
    assert mesh_preview(edited)["volume"] == pytest.approx(30 * 18 * 9)
    assert mesh_preview(spec)["volume"] == pytest.approx(3888)


def test_open_or_inconsistently_oriented_mesh_is_rejected():
    spec = cube_spec()
    spec["reference"]["faces"].pop()
    with pytest.raises(ValueError, match="cerrada"):
        mesh_preview(spec)
    spec = cube_spec()
    spec["reference"]["faces"][0].reverse()
    with pytest.raises(ValueError, match="orientación"):
        mesh_export_step(spec)


def test_new_parametric_hole_on_mesh_retains_cylinder_in_step_and_changes_stl():
    spec = cube_spec()
    spec["operations"] = [{"mode": "cut", "shape": "cylinder", "axis": "z",
                           "parameters": {"x": 40, "y": -15, "z": 6,
                                          "height": 20, "diameter": 6}}]
    expected = 3888 - math.pi * 3 ** 2 * 9
    preview = mesh_preview(spec)
    assert preview["valid"] and preview["volume"] == pytest.approx(expected, rel=1e-8)
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "new-hole.step"
        path.write_bytes(mesh_export_step(spec))
        restored = cq.importers.importStep(str(path)).val()
    assert restored.isValid() and len(restored.Solids()) == 1
    assert restored.Volume(tol=1e-8) == pytest.approx(expected, rel=1e-8)
    assert any(face.geomType() == "CYLINDER" for face in restored.Faces())
    stl = trimesh.load_mesh(__import__("io").BytesIO(mesh_export_stl(spec)), file_type="stl")
    assert stl.is_watertight and stl.volume == pytest.approx(expected, rel=2e-4)
    spec["operations"][0]["parameters"]["diameter"] = 8
    assert mesh_preview(spec)["volume"] == pytest.approx(3888 - math.pi * 4 ** 2 * 9)
    # Added operations do not mutate the cached faceted reference.
    assert mesh_preview(cube_spec())["volume"] == pytest.approx(3888)


@pytest.mark.parametrize("mutate", [
    lambda spec: spec["reference"]["vertices"][0].__setitem__(0, float("nan")),
    lambda spec: spec["reference"]["faces"][0].__setitem__(0, -1),
    lambda spec: spec["reference"]["faces"][0].__setitem__(0, 0.5),
    lambda spec: spec["parameters"].__setitem__("width", True),
    lambda spec: spec["parameters"].__setitem__("height", 1e-8),
    lambda spec: spec["parameters"].__setitem__("depth", 100_001),
    lambda spec: spec["parameters"].__setitem__("hole_diameter", 4),
])
def test_invalid_reference_and_scale_are_rejected(mutate):
    spec = cube_spec()
    mutate(spec)
    with pytest.raises(ValueError):
        mesh_preview(spec)
