"""Geometry tests exercise actual STL topology and reimport actual STEP files."""

import math
from pathlib import Path
import struct
import tempfile

import cadquery as cq
import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from backend.geometry import (
    MAX_STL_BYTES,
    analyze_stl,
    build_model,
    demo_stl,
    export_step,
    export_stl,
    load_stl,
    model_preview,
)


SPECS = [
    {"kind": "box", "parameters": {"width": 24, "depth": 16, "height": 8}},
    {"kind": "cylinder", "parameters": {"diameter": 20, "height": 8}},
    {"kind": "tube", "parameters": {"diameter": 20, "inner_diameter": 12, "height": 8}},
    {"kind": "plate", "parameters": {"width": 50, "depth": 32, "height": 5,
                                      "hole_diameter": 8, "hole_x": 10, "hole_y": 2}},
]


def _export_shape(shape: cq.Shape, ascii: bool = False) -> bytes:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "fixture.stl"
        shape.exportStl(str(path), tolerance=.02, angularTolerance=.08, relative=False, ascii=ascii)
        return path.read_bytes()


@pytest.mark.parametrize("spec", SPECS, ids=lambda spec: spec["kind"])
def test_recognize_actual_stl_and_rebuild_analytic_solid(spec):
    result = analyze_stl(export_stl(spec), name="ejemplo.stl")
    assert result["name"] == "ejemplo.stl"
    assert result["analysis"]["watertight"]
    assert result["recognition"]["kind"] == spec["kind"]
    assert result["model"]["valid"]
    for parameter, expected in spec["parameters"].items():
        assert result["recognition"]["parameters"][parameter] == pytest.approx(expected, abs=1e-4)
    rebuilt = build_model(result["recognition"])
    assert rebuilt.Volume() == pytest.approx(build_model(spec).Volume(), rel=1e-6)
    assert len(rebuilt.Faces()) <= 7  # Analytic faces, not hundreds of triangular faces.
    assert result["recognition"]["error_mm"] < .01


@pytest.mark.parametrize("spec", SPECS, ids=lambda spec: spec["kind"])
def test_rotated_translated_mesh_preserves_world_position_and_volume(spec):
    matrix = np.eye(4)
    matrix[:3, :3] = Rotation.from_euler("xyz", [33, -18, 21], degrees=True).as_matrix()
    matrix[:3, 3] = [37, -21, 13]
    transformed = dict(spec, transform=matrix.tolist())
    original = build_model(transformed)
    result = analyze_stl(export_stl(transformed))
    assert result["recognition"] is not None
    assert result["recognition"]["kind"] == spec["kind"]
    rebuilt = build_model(result["recognition"])
    assert rebuilt.Volume() == pytest.approx(original.Volume(), rel=2e-5)
    assert np.array(rebuilt.Center().toTuple()) == pytest.approx(original.Center().toTuple(), abs=1e-4)
    # Bidirectional bounds complement the centre/volume checks.
    a, b = original.BoundingBox(), rebuilt.BoundingBox()
    for key in ("xmin", "xmax", "ymin", "ymax", "zmin", "zmax"):
        assert getattr(a, key) == pytest.approx(getattr(b, key), abs=2e-4)


def test_ascii_and_units_scale_dimensions_and_volume():
    data = _export_shape(build_model(SPECS[0]), ascii=True)
    mesh = load_stl(data, units="cm")
    assert mesh.watertight
    assert np.ptp(mesh.vertices, axis=0).tolist() == pytest.approx([240, 160, 80])
    result = analyze_stl(data, units="in")
    assert result["source_units"] == "in"
    assert result["analysis"]["volume"] == pytest.approx(24 * 16 * 8 * 25.4 ** 3)


def test_step_export_retains_analytic_cylinder_and_edited_dimensions():
    spec = {"kind": "tube", "parameters": {"diameter": 24, "inner_diameter": 10, "height": 15}}
    data = export_step(spec)
    assert data.startswith(b"ISO-10303-21;")
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "edited.step"
        path.write_bytes(data)
        restored = cq.importers.importStep(str(path)).val()
    assert restored.isValid()
    assert len(restored.Solids()) == 1
    assert restored.Volume() == pytest.approx(math.pi * (12 ** 2 - 5 ** 2) * 15, rel=1e-8)
    assert sum(face.geomType() == "CYLINDER" for face in restored.Faces()) == 2
    assert len(restored.Faces()) == 4
    preview = model_preview(spec)
    assert preview["valid"] and preview["mesh"]["faces"]
    assert preview["volume"] == pytest.approx(restored.Volume())


def test_demo_is_a_recognizable_printable_plate():
    result = analyze_stl(demo_stl())
    assert result["recognition"]["kind"] == "plate"
    assert result["recognition"]["parameters"]["hole_diameter"] == pytest.approx(8, abs=1e-5)


def test_open_nonmanifold_or_inconsistent_mesh_remains_reference_only():
    binary = export_stl(SPECS[0])
    # Removing one facet produces three boundary edges.
    opened = binary[:80] + struct.pack("<I", 11) + binary[84:84 + 11 * 50]
    result = analyze_stl(opened)
    assert not result["analysis"]["watertight"]
    assert result["analysis"]["volume"] is None
    assert result["recognition"] is None and result["model"] is None
    # Duplicate one facet produces nonmanifold edges.
    duplicated = binary[:80] + struct.pack("<I", 13) + binary[84:] + binary[84:134]
    assert not analyze_stl(duplicated)["analysis"]["watertight"]
    # Reverse just one triangle without changing its geometry.
    reversed_face = bytearray(binary)
    reversed_face[108:120], reversed_face[120:132] = binary[120:132], binary[108:120]
    result = analyze_stl(bytes(reversed_face))
    assert result["analysis"]["watertight"]
    assert result["recognition"] is None
    assert any("orientación" in warning for warning in result["analysis"]["warnings"])


@pytest.mark.parametrize("shape", [
    cq.Solid.makeCone(10, 5, 8),
    cq.Solid.makeTorus(10, 3),
    cq.Workplane("XY").polygon(6, 20).extrude(8).val(),
    cq.Workplane("XY").box(30, 20, 5).faces(">Z").workplane().pushPoints([(-8, 0), (8, 0)]).hole(4).val(),
    cq.Workplane("XY").box(30, 20, 5).faces(">Z").workplane().hole(4, depth=2).val(),
])
def test_unsupported_closed_shapes_are_not_mislabeled(shape):
    result = analyze_stl(_export_shape(shape))
    assert result["analysis"]["watertight"]
    assert result["recognition"] is None
    assert result["model"] is None


def test_disconnected_solids_are_not_combined_into_one_candidate():
    shape = cq.Compound.makeCompound([build_model(SPECS[0]), build_model(SPECS[0]).translate((50, 0, 0))])
    result = analyze_stl(_export_shape(shape))
    assert result["recognition"] is None
    assert any("2 cuerpos" in warning for warning in result["analysis"]["warnings"])


@pytest.mark.parametrize("spec", [
    {"kind": "unknown", "parameters": {}},
    {"kind": [], "parameters": {}},
    {"kind": "box", "parameters": {"width": -1, "depth": 2, "height": 3}},
    {"kind": "box", "parameters": {"width": float("nan"), "depth": 2, "height": 3}},
    {"kind": "box", "parameters": {"width": True, "depth": 2, "height": 3}},
    {"kind": "box", "parameters": {"width": 1, "depth": 2}},
    {"kind": "tube", "parameters": {"diameter": 10, "inner_diameter": 10, "height": 3}},
    {"kind": "plate", "parameters": {"width": 10, "depth": 10, "height": 2,
                                      "hole_diameter": 4, "hole_x": 4, "hole_y": 0}},
    dict(SPECS[0], transform=np.diag([2, 2, 2, 1]).tolist()),
    dict(SPECS[0], transform=[[1, 0], [0, 1]]),
    dict(SPECS[0], transform=np.diag([-1, 1, 1, 1]).tolist()),
])
def test_invalid_specs_raise_user_errors(spec):
    with pytest.raises(ValueError):
        build_model(spec)


@pytest.mark.parametrize("data", [b"", b"not an stl", b"solid a\nvertex nan 0 0\nendsolid a",
                                   b"x" * (MAX_STL_BYTES + 1)])
def test_invalid_stl_raises_user_error(data):
    with pytest.raises(ValueError):
        load_stl(data)


def test_binary_nonfinite_coordinates_and_unknown_units_are_rejected():
    data = bytearray(export_stl(SPECS[0]))
    struct.pack_into("<f", data, 96, float("inf"))
    with pytest.raises(ValueError, match="no finitas"):
        load_stl(bytes(data))
    with pytest.raises(ValueError, match="Unidad"):
        load_stl(export_stl(SPECS[0]), "feet")
