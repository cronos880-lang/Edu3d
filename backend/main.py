"""API local de Edu3d y publicación de la interfaz compilada.

Ejecutar desde la raíz del proyecto con ``uvicorn backend.main:app --host
127.0.0.1 --port 8000``. Las operaciones del kernel se ejecutan en los hilos
de FastAPI y se serializan para evitar operaciones concurrentes de OpenCascade.
"""

from pathlib import Path
from threading import Lock
from typing import Annotated, Literal

import cadquery
import OCP
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend.geometry import (
    analyze_stl,
    demo_stl,
    export_step,
    export_stl,
    model_preview,
)
from backend.mesh_solid import mesh_export_step, mesh_export_stl, mesh_preview


MAX_UPLOAD_BYTES = 20 * 1024 * 1024
FRONTEND_DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"
KERNEL_LOCK = Lock()

FiniteNumber = Annotated[float, Field(strict=True, allow_inf_nan=False)]
TransformRow = Annotated[list[FiniteNumber], Field(min_length=4, max_length=4)]
TransformMatrix = Annotated[list[TransformRow], Field(min_length=4, max_length=4)]
Point3 = Annotated[list[FiniteNumber], Field(min_length=3, max_length=3)]
VertexIndex = Annotated[int, Field(strict=True, ge=0)]
Triangle = Annotated[list[VertexIndex], Field(min_length=3, max_length=3)]


class MeshReference(BaseModel):
    """Geometría de referencia acotada para crear un sólido de caras planas."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    vertices: Annotated[list[Point3], Field(min_length=4, max_length=75_000)]
    faces: Annotated[list[Triangle], Field(min_length=4, max_length=25_000)]


class Operation(BaseModel):
    """Una operación nueva, posicionada con coordenadas globales en milímetros."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    mode: Literal["cut", "add"]
    shape: Literal["cylinder", "box"]
    axis: Literal["x", "y", "z"]
    parameters: Annotated[dict[str, FiniteNumber], Field(max_length=6)]

    @model_validator(mode="after")
    def validate_operation(self) -> "Operation":
        required = {"x", "y", "z", "height"}
        required |= {"diameter"} if self.shape == "cylinder" else {"width", "depth"}
        if set(self.parameters) != required:
            raise ValueError(
                "Parámetros requeridos para la operación: "
                + ", ".join(sorted(required)) + "."
            )
        if self.shape == "box" and self.axis != "z":
            raise ValueError("La operación rectangular utiliza el eje z.")
        return self


class ModelSpec(BaseModel):
    """Parámetros explícitos de una reconstrucción editable en milímetros."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    kind: Literal["box", "cylinder", "tube", "plate", "mesh"]
    parameters: Annotated[dict[str, FiniteNumber], Field(max_length=32)]
    transform: TransformMatrix | None = None
    reference: MeshReference | None = None
    operations: Annotated[list[Operation], Field(max_length=12)] | None = None

    @model_validator(mode="after")
    def validate_reference(self) -> "ModelSpec":
        if self.kind == "mesh":
            if self.reference is None:
                raise ValueError("El sólido de referencia necesita su malla original.")
            if self.transform is not None:
                raise ValueError("El sólido de referencia no admite una transformación adicional.")
        elif self.reference is not None:
            raise ValueError("Solo el sólido de referencia admite una malla original.")
        return self


app = FastAPI(
    title="Edu3d",
    description="Diseño CAD personal y reconstrucción asistida de piezas STL.",
    version="0.1.0",
)


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, exc: RequestValidationError) -> JSONResponse:
    # Do not echo arbitrary uploaded content or non-finite JSON values in errors.
    messages = {
        "missing": "Este campo es obligatorio.",
        "literal_error": "Opción no admitida.",
        "finite_number": "Introduce un número finito.",
        "float_type": "Introduce un número.",
        "float_parsing": "Introduce un número válido.",
        "list_type": "Se esperaba una lista.",
        "dict_type": "Se esperaba un objeto.",
        "too_short": "El campo tiene menos elementos de los necesarios.",
        "too_long": "El campo contiene demasiados elementos.",
        "extra_forbidden": "Este campo no está permitido.",
        "json_invalid": "El JSON no es válido.",
    }
    errors = []
    for error in exc.errors():
        message = messages.get(error["type"], "Valor no válido.")
        if error["type"] == "value_error":
            reason = error.get("ctx", {}).get("error")
            if isinstance(reason, ValueError):
                message = str(reason)
        errors.append({
            "field": ".".join(str(part) for part in error["loc"]),
            "message": message,
        })
    return JSONResponse(
        status_code=422,
        content={"detail": "Revisa los datos de la solicitud.", "errors": errors},
    )


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "kernel": "OpenCascade",
        "version": OCP.__version__,
        "cadquery_version": cadquery.__version__,
    }


@app.get("/api/demo")
def demo() -> dict:
    with KERNEL_LOCK:
        return analyze_stl(demo_stl(), units="mm", name="pieza-demo.stl")


@app.post("/api/analyze")
def analyze(
    file: Annotated[UploadFile, File()],
    units: Annotated[Literal["mm", "cm", "in"], Form()] = "mm",
) -> dict:
    name = (file.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    if not name.lower().endswith(".stl"):
        raise HTTPException(422, "Selecciona un archivo con extensión .stl.")

    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "El archivo supera el límite de 20 MiB.")
    if not data:
        raise HTTPException(422, "El archivo STL está vacío.")

    try:
        with KERNEL_LOCK:
            return analyze_stl(data, units=units, name=name[:240])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/api/model")
def preview(spec: ModelSpec) -> dict:
    try:
        with KERNEL_LOCK:
            renderer = mesh_preview if spec.kind == "mesh" else model_preview
            return renderer(spec.model_dump(exclude_none=True))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def export_model(spec: ModelSpec, *, step: bool) -> Response:
    try:
        with KERNEL_LOCK:
            if spec.kind == "mesh":
                exporter = mesh_export_step if step else mesh_export_stl
            else:
                exporter = export_step if step else export_stl
            data = exporter(spec.model_dump(exclude_none=True))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    extension = "step" if step else "stl"
    return Response(
        content=data,
        media_type="application/step" if step else "model/stl",
        headers={
            "Content-Disposition": f'attachment; filename="edu3d-pieza.{extension}"',
            "Cache-Control": "no-store",
        },
    )


@app.post("/api/export/step")
def download_step(spec: ModelSpec) -> Response:
    return export_model(spec, step=True)


@app.post("/api/export/stl")
def download_stl(spec: ModelSpec) -> Response:
    return export_model(spec, step=False)


@app.api_route(
    "/api/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    include_in_schema=False,
)
@app.api_route(
    "/api",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    include_in_schema=False,
)
def unknown_api(path: str = "") -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": "Ruta API no encontrada."})


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str = "") -> Response:
    dist = FRONTEND_DIST.resolve()
    index = dist / "index.html"
    if not index.is_file():
        return HTMLResponse(
            "<!doctype html><html lang='es'><meta charset='utf-8'>"
            "<title>Edu3d</title><h1>Edu3d</h1>"
            "<p>La API está disponible. Compila la interfaz con "
            "<code>cd frontend &amp;&amp; npm run build</code> "
            "o inicia el servidor de desarrollo.</p></html>",
            status_code=503,
        )
    candidate = (dist / path).resolve()
    if not candidate.is_relative_to(dist):
        raise HTTPException(404, "Archivo no encontrado.")
    if candidate.is_file():
        return FileResponse(candidate)
    if path.startswith("assets/") or Path(path).suffix:
        raise HTTPException(404, "Archivo no encontrado.")
    return FileResponse(index)
