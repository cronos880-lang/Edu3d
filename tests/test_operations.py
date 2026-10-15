"""Boolean features are rebuilt from an unchanged base and survive STEP I/O."""

from copy import deepcopy
import math
from pathlib import Path
import tempfile

import cadquery as cq
import numpy as np
import pytest

from backend.geometry import build_model, export_step, export_stl, load_stl, model_preview
from backend.operations import apply_operations


BASE = {"kind": "box", "parameters": {"width": 20, "depth": 16, "height": 10}}


def cylinder(mode="cut", axis="z", **parameters):
    defaults = {"x": 0, "y": 0, "z": 5, "height": 50, "diameter": 4}
    defaults.update(parameters)
    return {"mode": mode, "shape": "cylinder", "axis": axis, "parameters": defaults}


def box(mode="cut", axis="z", **parameters):
    defaults = {"x": 0, "y": 0, "z": 5, "width": 4, "depth": 6, "height": 20}
    defaults.update(parameters)
    return {"mode": mode, "shape": "box", "axis": axis, "parameters": defaults}


@pytest.mark.parametrize("axis,length", [("x", 20), ("y", 16), ("z", 10)])
def test_cylindrical_cut_has_centered_global_axis_and_expected_volume(axis, length):
    spec = dict(BASE, operations=[cylinder(axis=axis)])
    shape = build_model(spec)
    assert shape.isValid() and len(shape.Solids()) == 1
    assert shape.Volume() == pytest.approx(3200 - math.pi * 2 ** 2 * length, rel=1e-8)
    assert sum(face.geomType() == "CYLINDER" for face in shape.Faces()) == 1


def test_box_cut_and_add_use_centers_in_all_three_coordinates():
    removed = build_model(dict(BASE, operations=[box(z=8, height=8)]))
    # The box extends from z=4 to z=12; six mm intersect the base.
    assert removed.Volume() == pytest.approx(3200 - 4 * 6 * 6)
    added = build_model(dict(BASE, operations=[box(mode="add", x=10, width=8, depth=6, height=4)]))
    assert added.Volume() == pytest.approx(3200 + 4 * 6 * 4)


def test_edit_reorder_and_remove_features_rebuild_from_unchanged_base():
    original = deepcopy(BASE)
    operations = [cylinder(mode="add", diameter=8, height=8, z=12),
                  cylinder(diameter=4, height=30, z=8)]
    operations_before = deepcopy(operations)
    shape = build_model(dict(BASE, operations=operations))
    assert shape.Volume() == pytest.approx(3200 + 6 * math.pi * 4 ** 2 - 16 * math.pi * 2 ** 2)
    edited = deepcopy(operations)
    edited[1]["parameters"]["diameter"] = 6
    smaller = build_model(dict(BASE, operations=edited))
    assert smaller.Volume() == pytest.approx(3200 + 6 * math.pi * 4 ** 2 - 16 * math.pi * 3 ** 2)
    reordered = build_model(dict(BASE, operations=list(reversed(operations))))
    assert reordered.Volume() == pytest.approx(3200 - 8 * math.pi * 2 ** 2 + 6 * math.pi * 4 ** 2)
    assert reordered.Volume() != pytest.approx(shape.Volume())
    removed = build_model(dict(BASE, operations=operations[:1]))
    assert removed.Volume() == pytest.approx(3200 + 6 * math.pi * 4 ** 2)
    assert build_model(dict(BASE, operations=[])).Volume() == pytest.approx(3200)
    assert BASE == original and operations == operations_before


def test_fill_existing_hole_then_add_a_new_explicit_diameter():
    plate = {"kind": "plate", "parameters": {"width": 40, "depth": 30, "height": 8,
              "hole_diameter": 8, "hole_x": 5, "hole_y": 0}}
    operations = [cylinder(mode="add", x=5, z=4, height=8, diameter=9),
                  cylinder(x=5, z=4, height=20, diameter=5)]
    result = build_model(dict(plate, operations=operations))
    assert result.isValid()
    assert result.Volume() == pytest.approx(40 * 30 * 8 - math.pi * 2.5 ** 2 * 8)
    assert sum(face.geomType() == "CYLINDER" for face in result.Faces()) == 1


def test_operations_are_in_world_coordinates_after_base_transform():
    matrix = np.eye(4)
    matrix[:3, 3] = [30, -20, 5]
    spec = dict(BASE, transform=matrix.tolist(), operations=[cylinder(x=30, y=-20, z=10)])
    assert build_model(spec).Volume() == pytest.approx(3200 - math.pi * 4 * 10)
    # Local coordinates would miss this translated base and must raise.
    with pytest.raises(ValueError, match="no intersecta"):
        build_model(dict(BASE, transform=matrix.tolist(), operations=[cylinder()]))


def test_preview_and_real_step_stl_include_edited_features():
    spec = dict(BASE, operations=[cylinder(diameter=6)])
    expected_volume = 3200 - math.pi * 3 ** 2 * 10
    preview = model_preview(spec)
    assert preview["valid"] and preview["volume"] == pytest.approx(expected_volume)
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "edited.step"
        path.write_bytes(export_step(spec))
        restored = cq.importers.importStep(str(path)).val()
    assert restored.isValid() and len(restored.Solids()) == 1
    assert restored.Volume() == pytest.approx(expected_volume, rel=1e-8)
    assert any(face.geomType() == "CYLINDER" for face in restored.Faces())
    mesh = load_stl(export_stl(spec))
    assert mesh.watertight and mesh.consistent
    assert mesh.volume == pytest.approx(expected_volume, rel=.001)


@pytest.mark.parametrize("operation,error", [
    (cylinder(x=100), "no intersecta"),
    (cylinder(mode="add", x=100), "no se une"),
    (cylinder(mode="add", diameter=2, height=2), "no incorpora"),
    (box(width=100, depth=100, height=100), "elimina toda"),
    (box(width=2, depth=30, height=30), "varios cuerpos"),
])
def test_missed_unchanged_disconnected_or_empty_results_are_rejected(operation, error):
    with pytest.raises(ValueError, match=error):
        build_model(dict(BASE, operations=[operation]))


@pytest.mark.parametrize("operations", [
    "cut", {}, (cylinder(),), [cylinder()] * 13,
    [{}], [dict(cylinder(), extra=True)], [dict(cylinder(), mode="erase")],
    [dict(cylinder(), mode=[])], [dict(cylinder(), shape="sphere")],
    [dict(cylinder(), shape=[])], [dict(cylinder(), axis="u")], [box(axis="x")],
    [dict(cylinder(), parameters={})],
    [cylinder(height=-1)], [cylinder(diameter=.001)], [cylinder(height=100001)],
    [cylinder(diameter=True)], [cylinder(x=float("nan"))], [cylinder(z=float("inf"))],
    [cylinder(x=1_000_001)], [cylinder(diameter="4")],
])
def test_operation_schema_strictly_rejects_bad_values(operations):
    with pytest.raises(ValueError):
        apply_operations(build_model(BASE), operations)


def test_none_empty_and_invalid_base_are_handled_without_mutation():
    shape = build_model(BASE)
    assert apply_operations(shape, None) is shape
    assert apply_operations(shape, []) is shape
    before = shape.Volume()
    changed = apply_operations(shape, [cylinder()])
    assert shape.Volume() == pytest.approx(before)
    assert changed.Volume() < before
    with pytest.raises(ValueError, match="pieza base"):
        apply_operations(cq.Compound.makeCompound([]), [])
