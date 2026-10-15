"""Punto de entrada protegido para un alojamiento con HTTPS.

El servidor de desarrollo conserva su comportamiento local. El despliegue usa
``uvicorn deploy.entrypoint:create_app_from_env --factory`` y necesita una
contraseña proporcionada por las variables del alojamiento.
"""

import base64
import binascii
import hashlib
import hmac
from os import environ

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class _BasicAuthGate:
    """Comprueba cada petición y conserva únicamente resúmenes en memoria."""

    def __init__(self, app: ASGIApp, username: str, password: str) -> None:
        self.app = app
        self._username_digest = hashlib.sha256(username.encode("utf-8")).digest()
        self._password_digest = hashlib.sha256(password.encode("utf-8")).digest()

    def _authenticated(self, scope: Scope) -> bool:
        headers = [value for name, value in scope["headers"] if name.lower() == b"authorization"]
        if len(headers) != 1:
            return False
        scheme, separator, encoded = headers[0].partition(b" ")
        if not separator or scheme.lower() != b"basic" or not encoded:
            return False
        try:
            credentials = base64.b64decode(encoded, validate=True)
            credentials.decode("utf-8")
        except (binascii.Error, ValueError, UnicodeDecodeError):
            return False
        username, separator, password = credentials.partition(b":")
        if not separator:
            return False
        # Ambas comparaciones se ejecutan incluso cuando el usuario no coincide.
        user_matches = hmac.compare_digest(
            hashlib.sha256(username).digest(), self._username_digest
        )
        password_matches = hmac.compare_digest(
            hashlib.sha256(password).digest(), self._password_digest
        )
        return user_matches and password_matches

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        public_health = (
            scope["path"] == "/api/health" and scope["method"] in {"GET", "HEAD"}
        )
        if not public_health and not self._authenticated(scope):
            response = JSONResponse(
                {"detail": "Autenticación requerida."},
                status_code=401,
                headers={
                    "WWW-Authenticate": 'Basic realm="Edu3d", charset="UTF-8"',
                    "Cache-Control": "no-store",
                },
            )
            await response(scope, receive, send)
            return

        if public_health and scope["method"] == "HEAD":
            # FastAPI publica health como GET; damos a HEAD la misma respuesta
            # sin cuerpo para los monitores del alojamiento.
            async def send_head(message: Message) -> None:
                if message["type"] == "http.response.body":
                    message = {**message, "body": b""}
                await send(message)

            await self.app({**scope, "method": "GET"}, receive, send_head)
            return
        await self.app(scope, receive, send)


def create_app(username: str, password: str) -> ASGIApp:
    """Construye la aplicación protegida sin leer ni modificar el entorno."""
    if not isinstance(password, str) or not password:
        raise ValueError("Configura EDU3D_PASSWORD antes de iniciar el alojamiento.")
    if (
        not isinstance(username, str)
        or not username
        or ":" in username
        or any(ord(character) < 32 or ord(character) == 127 for character in username)
    ):
        raise ValueError("EDU3D_USER debe ser un nombre no vacío y sin dos puntos ni caracteres de control.")

    from backend.main import app

    return _BasicAuthGate(app, username, password)


def create_app_from_env() -> ASGIApp:
    """Fábrica para Uvicorn: falla al arrancar si falta la contraseña."""
    return create_app(
        username=environ.get("EDU3D_USER", "edu3d"),
        password=environ.get("EDU3D_PASSWORD", ""),
    )
