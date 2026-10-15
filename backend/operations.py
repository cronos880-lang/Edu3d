"""Explicit, ordered CAD features added by the user to an existing solid.

These operations do not infer or recover features from the imported STL. All
tool centres and axes are expressed in global millimetre coordinates.
"""

from __future__ import annotations

import math

import cadquery as cq


MAX_OPERATIONS = 12
_OPERATION_KEYS = {"mode", "shape", "axis", "parameters"}
_PARAMETER_KEYS = {
    "cylinder": {"x", "y", "z", "height", "diameter"},
    "box": {"x", "y", "z", "width", "depth", "height"},
}
_AXES = {"x": (1., 0., 0.), "y": (0., 1., 0.), "z": (0., 0., 1.)}


def _validate_operations(operations: list | None) -> list[dict]:
    if operations is None:
        return []
    if not isinstance(operations, list) or len(operations) > MAX_OPERATIONS:
        raise ValueError("Las operaciones deben ser una lista con un máximo de 12 elementos.")
    validated = []
    for index, operation in enumerate(operations, start=1):
        prefix = f"Operación {index}: "
        if not isinstance(operation, dict) or set(operation) != _OPERATION_KEYS:
            raise ValueError(prefix + "se requieren exactamente mode, shape, axis y parameters.")
        mode, kind, axis = operation["mode"], operation["shape"], operation["axis"]
        if not isinstance(mode, str) or mode not in {"cut", "add"}:
            raise ValueError(prefix + "mode debe ser cut o add.")
        if not isinstance(kind, str) or kind not in _PARAMETER_KEYS:
            raise ValueError(prefix + "shape debe ser cylinder o box.")
        if not isinstance(axis, str) or axis not in _AXES or (kind == "box" and axis != "z"):
            raise ValueError(prefix + "el eje debe ser x, y o z; para una caja debe ser z.")
        parameters = operation["parameters"]
        if not isinstance(parameters, dict) or set(parameters) != _PARAMETER_KEYS[kind]:
            raise ValueError(prefix + "parámetros requeridos: " + ", ".join(sorted(_PARAMETER_KEYS[kind])) + ".")
        values = {}
        for key, value in parameters.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(prefix + f"{key} debe ser un número finito.")
            value = float(value)
            if key in {"x", "y", "z"}:
                if abs(value) > 1_000_000:
                    raise ValueError(prefix + f"la coordenada {key} excede 1.000.000 mm.")
            elif not .01 <= value <= 100_000:
                raise ValueError(prefix + f"{key} debe estar entre 0,01 y 100.000 mm.")
            values[key] = value
        validated.append({"mode": mode, "shape": kind, "axis": axis, "parameters": values})
    return validated


def _tool(operation: dict) -> cq.Shape:
    parameters = operation["parameters"]
    center = cq.Vector(parameters["x"], parameters["y"], parameters["z"])
    if operation["shape"] == "box":
        return cq.Workplane("XY").box(parameters["width"], parameters["depth"], parameters["height"]).val().translate(center)
    axis = cq.Vector(*_AXES[operation["axis"]])
    start = center - axis * (parameters["height"] / 2)
    return cq.Solid.makeCylinder(parameters["diameter"] / 2, parameters["height"], start, axis)


def apply_operations(base: cq.Shape, operations: list | None) -> cq.Shape:
    """Rebuild each feature in order and return one valid, positive solid.

    A feature that misses the part, adds no material, removes the whole part,
    or splits it into separate bodies raises a descriptive Spanish ValueError.
    The base shape and operation dictionaries are never modified.
    """
    checked = _validate_operations(operations)
    if not isinstance(base, cq.Shape) or len(base.Solids()) != 1 or not base.isValid():
        raise ValueError("La pieza base debe ser un único sólido CAD válido.")
    # Adaptive integration matters for imported, scaled BSpline faces: default
    # OCCT volume integration can otherwise obscure very small feature changes.
    before = float(base.Volume(tol=1e-8))
    if not math.isfinite(before) or before <= 0:
        raise ValueError("La pieza base debe tener volumen positivo.")
    current = base
    for index, operation in enumerate(checked, start=1):
        prefix = f"Operación {index}: "
        try:
            tool = _tool(operation)
            candidate = current.cut(tool) if operation["mode"] == "cut" else current.fuse(tool)
            solids = candidate.Solids()
            if not solids:
                raise ValueError(prefix + "el corte elimina toda la pieza; reduce sus dimensiones o cambia su posición.")
            if len(solids) != 1:
                if operation["mode"] == "add":
                    raise ValueError(prefix + "la adición no se une a la pieza; sitúala en contacto con el sólido.")
                raise ValueError(prefix + "el corte divide la pieza en varios cuerpos separados.")
            if not candidate.isValid():
                raise ValueError(prefix + "el resultado no es un sólido válido; ajusta la posición o las dimensiones.")
            # Removing boolean splitters is useful for both analytic parts and
            # faceted imports. Keep the valid uncleaned result if cleanup fails.
            try:
                clean = candidate.clean()
                if clean.isValid() and len(clean.Solids()) == 1:
                    candidate = clean
            except Exception:
                pass
            candidate = candidate.Solids()[0]
            after = float(candidate.Volume(tol=1e-8))
            if not math.isfinite(after) or after <= 0:
                raise ValueError(prefix + "el resultado debe conservar volumen positivo.")
            tolerance = max(1e-10, max(before, after) * 1e-10)
            if operation["mode"] == "cut" and before - after <= tolerance:
                raise ValueError(prefix + "el corte no intersecta la pieza o no retira material medible.")
            if operation["mode"] == "add" and after - before <= tolerance:
                raise ValueError(prefix + "la adición no incorpora material nuevo; puede estar dentro de la pieza.")
            current, before = candidate, after
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError(prefix + "no se pudo calcular la operación; ajusta la posición o las dimensiones.") from exc
    return current
