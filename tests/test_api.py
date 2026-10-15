"""Pruebas del contrato HTTP y de la exportación CAD real."""

import io
import json
import math
import struct

import cadquery as cq
import pytest
import trimesh
from fastapi.testclient import TestClient

from backend import main


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def stl_bytes(tmp_path):
    path = tmp_path / "fixture.stl"
    cq.exporters.export(cq.Workplane("XY").box(20, 30, 10), str(path))
    return path.read_bytes()


@pytest.fixture
def mesh_spec(stl_bytes):
    mesh = trimesh.load(io.BytesIO(stl_bytes), file_type="stl", force="mesh")
    return {
        "kind": "mesh",
        "parameters": {"width": 24, "depth": 18, "height": 9},
        "reference": {
            "vertices": mesh.vertices.tolist(),
            "faces": mesh.faces.tolist(),
        },
    }


def test_health_reports_real_kernel(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "ok"
    assert result["kernel"] == "OpenCascade"
    assert result["version"]


def test_binary_stl_upload_and_demo(client, stl_bytes):
    # CadQuery's exported STL is binary, not an ASCII-only test fixture.
    assert len(stl_bytes) == 84 + 50 * struct.unpack("<I", stl_bytes[80:84])[0]
    response = client.post(
        "/api/analyze", files={"file": ("pieza.stl", stl_bytes)}, data={"units": "mm"}
    )
    assert response.status_code == 200, response.text
    analysis = response.json()
    assert analysis["analysis"]["watertight"] is True
    assert analysis["analysis"]["dimensions"] == pytest.approx([20, 30, 10])
    assert analysis["analysis"]["volume"] == pytest.approx(20 * 30 * 10)
    assert analysis["recognition"]["kind"] == "box"
    assert analysis["model"]["valid"] is True

    scaled = client.post(
        "/api/analyze", files={"file": ("pieza.stl", stl_bytes)}, data={"units": "cm"}
    )
    assert scaled.status_code == 200, scaled.text
    assert scaled.json()["analysis"]["dimensions"] == pytest.approx([200, 300, 100])
    demo = client.get("/api/demo")
    assert demo.status_code == 200, demo.text
    assert demo.json()["recognition"]["kind"] == "plate"
    assert demo.json()["model"]["valid"] is True


def test_edit_export_reimports_step_and_stl(client, tmp_path):
    spec = {"kind": "box", "parameters": {"width": 24, "depth": 18, "height": 6}}
    preview = client.post("/api/model", json=spec)
    assert preview.status_code == 200, preview.text
    assert preview.json()["valid"] is True
    assert preview.json()["volume"] == pytest.approx(24 * 18 * 6)
    assert preview.json()["mesh"]["faces"]

    spec["parameters"]["height"] = 9
    exported = client.post("/api/export/step", json=spec)
    assert exported.status_code == 200, exported.text
    assert 'filename="edu3d-pieza.step"' in exported.headers["content-disposition"]
    step_path = tmp_path / "edited.step"
    step_path.write_bytes(exported.content)
    solid = cq.importers.importStep(str(step_path)).val()
    assert solid.isValid()
    assert solid.Volume() == pytest.approx(24 * 18 * 9)
    assert solid.BoundingBox().zlen == pytest.approx(9)

    stl = client.post("/api/export/stl", json=spec)
    assert stl.status_code == 200, stl.text
    mesh = trimesh.load(io.BytesIO(stl.content), file_type="stl", force="mesh")
    assert mesh.is_watertight
    assert mesh.volume == pytest.approx(24 * 18 * 9)


@pytest.mark.parametrize(
    ("filename", "content", "units"),
    [
        ("pieza.obj", b"not an STL", "mm"),
        ("empty.stl", b"", "mm"),
        ("broken.stl", b"not an STL", "mm"),
        ("pieza.stl", b"anything", "yards"),
    ],
)
def test_invalid_upload_has_spanish_json_error(client, filename, content, units):
    result = client.post(
        "/api/analyze", files={"file": (filename, content)}, data={"units": units}
    )
    assert result.status_code == 422
    assert isinstance(result.json()["detail"], str)


def test_upload_size_limit(client, monkeypatch):
    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 8)
    result = client.post("/api/analyze", files={"file": ("big.stl", b"123456789")})
    assert result.status_code == 413


@pytest.mark.parametrize("number", ["NaN", "Infinity", "-Infinity"])
def test_nonfinite_parameters_are_rejected_as_json(client, number):
    result = client.post(
        "/api/model",
        content='{"kind":"box","parameters":{"width":' + number + ',"depth":2,"height":3}}',
        headers={"Content-Type": "application/json"},
    )
    assert result.status_code == 422
    assert "detail" in result.json()


def test_invalid_model_and_transform(client):
    invalid = client.post(
        "/api/model",
        json={"kind": "box", "parameters": {"width": -1, "depth": 2, "height": 3}},
    )
    assert invalid.status_code == 422
    unsupported = client.post("/api/model", json={"kind": "arbitrary", "parameters": {}})
    assert unsupported.status_code == 422
    transform = client.post(
        "/api/model",
        json={
            "kind": "box",
            "parameters": {"width": 1, "depth": 2, "height": 3},
            "transform": [[1, 0], [0, 1]],
        },
    )
    assert transform.status_code == 422


def test_export_preserves_rigid_placement(client, tmp_path):
    response = client.post(
        "/api/export/step",
        json={
            "kind": "cylinder",
            "parameters": {"diameter": 12, "height": 8},
            "transform": [
                [1, 0, 0, 30],
                [0, 1, 0, -20],
                [0, 0, 1, 5],
                [0, 0, 0, 1],
            ],
        },
    )
    assert response.status_code == 200, response.text
    path = tmp_path / "placed.step"
    path.write_bytes(response.content)
    bounds = cq.importers.importStep(str(path)).val().BoundingBox()
    assert bounds.xmin == pytest.approx(24)
    assert bounds.ymin == pytest.approx(-26)
    assert bounds.zmin == pytest.approx(5)
    assert bounds.zmax == pytest.approx(13)


def test_reference_mesh_scales_and_exports_a_real_solid(client, mesh_spec, tmp_path):
    preview = client.post("/api/model", json=mesh_spec)
    assert preview.status_code == 200, preview.text
    assert preview.json()["valid"] is True
    assert preview.json()["volume"] == pytest.approx(24 * 18 * 9)

    exported = client.post("/api/export/step", json=mesh_spec)
    assert exported.status_code == 200, exported.text
    path = tmp_path / "reference.step"
    path.write_bytes(exported.content)
    solid = cq.importers.importStep(str(path)).val()
    assert solid.isValid()
    assert len(solid.Solids()) == 1
    assert solid.Volume() == pytest.approx(24 * 18 * 9)
    bounds = solid.BoundingBox()
    assert [bounds.xlen, bounds.ylen, bounds.zlen] == pytest.approx([24, 18, 9])
    assert [bounds.xmin, bounds.ymin, bounds.zmin] == pytest.approx([-12, -9, -4.5])

    stl = client.post("/api/export/stl", json=mesh_spec)
    assert stl.status_code == 200, stl.text
    mesh = trimesh.load(io.BytesIO(stl.content), file_type="stl", force="mesh")
    assert mesh.is_watertight
    assert mesh.volume == pytest.approx(24 * 18 * 9)


def test_open_reference_mesh_is_rejected(client, mesh_spec):
    mesh_spec["reference"]["faces"] = mesh_spec["reference"]["faces"][:-2]
    result = client.post("/api/export/step", json=mesh_spec)
    assert result.status_code == 422
    assert isinstance(result.json()["detail"], str)


def test_reference_mesh_triangle_limit(client, mesh_spec):
    mesh_spec["reference"]["faces"] = [mesh_spec["reference"]["faces"][0]] * 25_001
    result = client.post("/api/model", json=mesh_spec)
    assert result.status_code == 422
    assert result.json()["errors"][0]["field"] == "body.reference.faces"


def test_reference_vertices_and_indices_are_strictly_validated(client, mesh_spec):
    mesh_spec["reference"]["vertices"][0][0] = float("nan")
    result = client.post(
        "/api/model",
        content=json.dumps(mesh_spec),
        headers={"Content-Type": "application/json"},
    )
    assert result.status_code == 422
    assert result.json()["errors"][0]["field"].startswith("body.reference.vertices")
    mesh_spec["reference"]["vertices"][0][0] = 0
    mesh_spec["reference"]["faces"][0][0] = True
    result = client.post("/api/model", json=mesh_spec)
    assert result.status_code == 422


def test_reference_is_required_only_for_mesh_and_cannot_be_transformed(client, mesh_spec):
    missing = client.post(
        "/api/model", json={"kind": "mesh", "parameters": mesh_spec["parameters"]}
    )
    assert missing.status_code == 422
    mesh_spec["transform"] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    transformed = client.post("/api/model", json=mesh_spec)
    assert transformed.status_code == 422
    del mesh_spec["transform"]
    mesh_spec["kind"] = "box"
    unnecessary = client.post("/api/model", json=mesh_spec)
    assert unnecessary.status_code == 422


def test_parametric_cut_can_be_edited_and_exported(client, tmp_path):
    spec = {
        "kind": "box",
        "parameters": {"width": 24, "depth": 18, "height": 9},
        "operations": [{
            "mode": "cut",
            "shape": "cylinder",
            "axis": "z",
            "parameters": {"x": 0, "y": 0, "z": 4.5, "height": 20, "diameter": 6},
        }],
    }
    first = client.post("/api/model", json=spec)
    assert first.status_code == 200, first.text
    assert first.json()["valid"] is True
    assert first.json()["volume"] == pytest.approx(24 * 18 * 9 - math.pi * 3**2 * 9)

    spec["operations"][0]["parameters"]["diameter"] = 8
    exported = client.post("/api/export/step", json=spec)
    assert exported.status_code == 200, exported.text
    path = tmp_path / "hole-edited.step"
    path.write_bytes(exported.content)
    solid = cq.importers.importStep(str(path)).val()
    assert solid.isValid()
    assert len(solid.Solids()) == 1
    assert solid.Volume() == pytest.approx(24 * 18 * 9 - math.pi * 4**2 * 9)


def test_mesh_reference_accepts_detail_operations(client, mesh_spec, tmp_path):
    mesh_spec["operations"] = [{
        "mode": "cut",
        "shape": "cylinder",
        "axis": "z",
        "parameters": {"x": 0, "y": 0, "z": 0, "height": 20, "diameter": 6},
    }]
    preview = client.post("/api/model", json=mesh_spec)
    assert preview.status_code == 200, preview.text
    assert preview.json()["valid"] is True
    assert preview.json()["volume"] == pytest.approx(24 * 18 * 9 - math.pi * 3**2 * 9)

    exported = client.post("/api/export/step", json=mesh_spec)
    assert exported.status_code == 200, exported.text
    path = tmp_path / "mesh-cut.step"
    path.write_bytes(exported.content)
    solid = cq.importers.importStep(str(path)).val()
    assert solid.isValid()
    assert solid.Volume() == pytest.approx(24 * 18 * 9 - math.pi * 3**2 * 9)


def test_operation_schema_rejects_invalid_fields_and_limit(client):
    spec = {
        "kind": "box",
        "parameters": {"width": 24, "depth": 18, "height": 9},
        "operations": [{
            "mode": "cut",
            "shape": "box",
            "axis": "x",
            "parameters": {"x": 0, "y": 0, "z": 4.5, "width": 6, "depth": 6, "height": 20},
        }],
    }
    assert client.post("/api/model", json=spec).status_code == 422
    operation = spec["operations"][0]
    operation["axis"] = "z"
    operation["unexpected"] = "field"
    assert client.post("/api/model", json=spec).status_code == 422
    del operation["unexpected"]
    del operation["parameters"]["width"]
    assert client.post("/api/model", json=spec).status_code == 422
    operation["parameters"]["width"] = 6
    spec["operations"] = [operation] * 13
    result = client.post("/api/model", json=spec)
    assert result.status_code == 422
    assert result.json()["errors"][0]["field"] == "body.operations"


def test_operation_parameters_must_be_finite(client):
    spec = {
        "kind": "box",
        "parameters": {"width": 24, "depth": 18, "height": 9},
        "operations": [{
            "mode": "cut",
            "shape": "cylinder",
            "axis": "z",
            "parameters": {"x": 0, "y": 0, "z": 4.5, "height": 20, "diameter": float("inf")},
        }],
    }
    result = client.post(
        "/api/model", content=json.dumps(spec), headers={"Content-Type": "application/json"}
    )
    assert result.status_code == 422
    assert result.json()["errors"][0]["field"] == "body.operations.0.parameters.diameter"


def test_unknown_api_never_returns_spa(client):
    for path in ["/api", "/api/unknown"]:
        result = client.get(path)
        assert result.status_code == 404
        assert result.headers["content-type"].startswith("application/json")


def test_frontend_build_and_traversal(client, monkeypatch, tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    monkeypatch.setattr(main, "FRONTEND_DIST", dist)
    assert client.get("/").status_code == 503
    (dist / "index.html").write_text("<h1>Edu3d</h1>")
    assets = dist / "assets"
    assets.mkdir()
    (assets / "app.js").write_text("console.log('Edu3d')")
    outside = tmp_path / "outside.txt"
    outside.write_text("private")
    (dist / "link.txt").symlink_to(outside)
    assert client.get("/").text == "<h1>Edu3d</h1>"
    assert client.get("/design/pieza").text == "<h1>Edu3d</h1>"
    assert client.get("/assets/app.js").status_code == 200
    assert client.get("/assets/missing.js").status_code == 404
    assert client.get("/link.txt").status_code == 404
    assert client.get("/%2e%2e/outside.txt").status_code == 404
