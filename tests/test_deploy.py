"""El acceso público protege también las rutas internas y los archivos estáticos."""

import base64
import secrets

import pytest
from fastapi.testclient import TestClient

from backend import main
from deploy import entrypoint


@pytest.fixture
def protected_app(monkeypatch, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<h1>Edu3d protegido</h1>")
    (dist / "assets" / "app.js").write_text("console.log('Edu3d')")
    monkeypatch.setattr(main, "FRONTEND_DIST", dist)
    credentials = ("usuario-prueba", secrets.token_urlsafe(32))
    with TestClient(entrypoint.create_app(*credentials)) as client:
        yield client, credentials


def _authorization(username, password):
    encoded = base64.b64encode(f"{username}:{password}".encode("utf-8"))
    return "Basic " + encoded.decode("ascii")


@pytest.mark.parametrize(
    "path", ["/", "/assets/app.js", "/api/demo", "/api/unknown", "/docs", "/openapi.json"]
)
def test_every_app_surface_requires_authentication(protected_app, path):
    client, credentials = protected_app
    response = client.get(path)
    assert response.status_code == 401
    assert response.json() == {"detail": "Autenticación requerida."}
    assert response.headers["www-authenticate"] == 'Basic realm="Edu3d", charset="UTF-8"'
    assert response.headers["cache-control"] == "no-store"
    assert credentials[1] not in response.text


def test_authenticated_browser_assets_docs_and_real_cad_work(protected_app):
    client, credentials = protected_app
    for path in ["/", "/assets/app.js", "/docs", "/openapi.json"]:
        response = client.get(path, auth=credentials)
        assert response.status_code == 200, path
    demo = client.get("/api/demo", auth=credentials)
    assert demo.status_code == 200
    assert demo.json()["recognition"]["kind"] == "plate"
    assert demo.json()["model"]["valid"] is True
    assert client.get("/api/unknown", auth=credentials).status_code == 404


@pytest.mark.parametrize(
    "header",
    [
        "Bearer ignored",
        "Basic",
        "Basic $$$",
        "Basic YWJj",  # Base64 válido, pero sin separador usuario/contraseña.
        "Basic /zph",  # Credenciales que no son UTF-8.
        "Basic ZWR1M2Q6aW52 YWxpZA==",  # No se permite espacio en Base64.
    ],
)
def test_malformed_authorization_is_rejected(protected_app, header):
    client, _credentials = protected_app
    response = client.get("/api/demo", headers={"Authorization": header})
    assert response.status_code == 401
    assert response.json() == {"detail": "Autenticación requerida."}


def test_wrong_credentials_and_duplicate_headers_are_rejected(protected_app):
    client, (username, password) = protected_app
    for attempted in [
        ("otro-usuario", password),
        (username, secrets.token_urlsafe(32)),
        ("otro-usuario", secrets.token_urlsafe(32)),
    ]:
        assert client.get("/api/demo", auth=attempted).status_code == 401
    response = client.get(
        "/api/demo",
        headers=[
            ("Authorization", _authorization(username, password)),
            ("Authorization", "Basic YWJjOmRlZg=="),
        ],
    )
    assert response.status_code == 401


def test_health_is_public_for_get_and_head_only(protected_app):
    client, _credentials = protected_app
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    head = client.head("/api/health")
    assert head.status_code == 200
    assert head.content == b""
    assert client.post("/api/health").status_code == 401
    assert client.get("/api/health/").status_code == 401


@pytest.mark.parametrize("configuration", [{}, {"EDU3D_PASSWORD": ""}])
def test_environment_factory_requires_nonempty_password(monkeypatch, configuration):
    # Sustituye solo la referencia de la fábrica, no las variables del proceso.
    monkeypatch.setattr(entrypoint, "environ", configuration)
    with pytest.raises(ValueError, match="EDU3D_PASSWORD"):
        entrypoint.create_app_from_env()


def test_environment_factory_uses_default_username_without_mutating_environment(monkeypatch):
    password = secrets.token_urlsafe(32)
    configuration = {"EDU3D_PASSWORD": password}
    monkeypatch.setattr(entrypoint, "environ", configuration)
    with TestClient(entrypoint.create_app_from_env()) as client:
        assert client.get("/api/unknown").status_code == 401
        assert client.get("/api/unknown", auth=("edu3d", password)).status_code == 404
    assert configuration == {"EDU3D_PASSWORD": password}


def test_basic_auth_supports_utf8_credentials(protected_app):
    _client, (_username, password) = protected_app
    username = "usuario-ñ"
    password = "contraseña-" + password
    with TestClient(entrypoint.create_app(username, password)) as client:
        response = client.get(
            "/api/unknown", headers={"Authorization": _authorization(username, password)}
        )
        assert response.status_code == 404
