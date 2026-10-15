#!/usr/bin/env python3
"""Exercise the real Edu3d interface against a running API and compiled UI.

Requires the development environment's Playwright and system Chromium. Outputs
screenshots, downloaded files and a JSON report outside the checkout by default.
Personal STL files are supplied through --sample and are never copied here.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import struct
import traceback
from pathlib import Path
from time import monotonic

from PIL import Image
from playwright.sync_api import Page, expect, sync_playwright


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", nargs="?", default="http://127.0.0.1:8000")
    parser.add_argument("--sample", type=Path, help="Optional STL to import and convert")
    parser.add_argument("--operations", action="store_true", help="Also require new cut/add operation editing")
    parser.add_argument("--project", type=Path, help="Also reopen a project and edit its first cylindrical detail")
    parser.add_argument("--output", type=Path, default=Path("/workspace/output/browser-smoke"))
    return parser.parse_args()


def idle(page: Page) -> None:
    expect(page.locator(".busy-overlay")).to_have_count(0, timeout=180_000)
    expect(page.get_by_role("alert")).to_have_count(0)


def no_horizontal_overflow(page: Page) -> dict:
    sizes = page.evaluate("""() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth
    })""")
    assert max(sizes["document"], sizes["body"]) <= sizes["viewport"] + 1, sizes
    return sizes


def capture_page(page: Page, path: Path) -> None:
    close = page.get_by_role("button", name="Cerrar aviso", exact=True)
    if close.count():
        close.click()
    page.screenshot(path=str(path), full_page=True)


def canvas_snapshot(page: Page, path: Path, *, solid: bool = False) -> dict:
    canvas = page.locator(".viewer canvas")
    expect(canvas).to_be_visible()
    expect(page.locator(".webgl-error")).to_have_count(0)
    page.wait_for_function("""() => {
        const c = document.querySelector('.viewer canvas');
        return c && c.width > 100 && c.height > 100;
    }""")
    # Two RAFs allow the rebuilt mesh to reach the GPU before capture.
    page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
    png = canvas.screenshot(path=str(path))
    image = Image.open(io.BytesIO(png)).convert("RGB")
    pixels = image.get_flattened_data() if hasattr(image, "get_flattened_data") else image.getdata()
    teal = sum(1 for r, g, b in pixels if r < g * .86 and b > r * 1.1 and g > 95 and abs(g - b) < 110)
    colors = len(image.getcolors(image.width * image.height) or [])
    assert colors > 30, f"The WebGL capture looks empty ({colors} colors)"
    if solid:
        assert teal > 200, f"The CAD solid is not visible in the canvas ({teal} teal pixels)"
    return {"width": image.width, "height": image.height, "colors": colors, "solid_pixels": teal}


def save_download(page: Page, button, destination: Path, *, step: bool = False) -> Path:
    with page.expect_download(timeout=180_000) as pending:
        button.click()
    download = pending.value
    assert not download.failure(), f"Download failed: {download.failure()}"
    path = destination / download.suggested_filename
    download.save_as(str(path))
    assert path.stat().st_size > 100, f"Empty download: {path.name}"
    if step:
        assert path.read_bytes().lstrip().startswith(b"ISO-10303-21;"), "Not an ISO STEP file"
    idle(page)
    return path


def add_error_listeners(page: Page, errors: list[dict]) -> None:
    page.on("pageerror", lambda error: errors.append({"kind": "pageerror", "message": str(error)}))
    page.on("console", lambda message: errors.append({"kind": "console", "message": message.text, "location": message.location}) if message.type == "error" else None)


def demo_flow(page: Page, output: Path, report: dict) -> None:
    expect(page.get_by_role("heading", name=re.compile("Dale nuevas medidas"))).to_be_visible()
    expect(page.get_by_role("button", name="Exportar STEP", exact=True)).to_be_disabled()
    report["empty_canvas"] = canvas_snapshot(page, output / "desktop-empty-canvas.png")
    report["desktop_empty_sizes"] = no_horizontal_overflow(page)
    capture_page(page, output / "desktop-empty.png")

    page.get_by_role("button", name="Probar pieza de ejemplo").click()
    expect(page.get_by_role("heading", name="Placa perforada", exact=True)).to_be_visible(timeout=180_000)
    idle(page)
    height = page.get_by_role("spinbutton", name="Altura en milímetros", exact=True)
    original = float(height.input_value())
    edited = original + 3.0
    height.fill(str(edited))
    page.get_by_role("button", name="Aplicar medidas", exact=True).click()
    idle(page)
    expect(height).to_have_value(str(int(edited)) if edited.is_integer() else str(edited))
    expect(page.get_by_text("Válido", exact=True)).to_be_visible()
    page.get_by_role("button", name="Deshacer", exact=True).click()
    idle(page)
    assert float(height.input_value()) == original
    page.get_by_role("button", name="Rehacer", exact=True).click()
    idle(page)
    assert float(height.input_value()) == edited
    report["demo_canvas"] = canvas_snapshot(page, output / "desktop-demo-canvas.png", solid=True)
    capture_page(page, output / "desktop-demo.png")
    step = save_download(page, page.get_by_role("button", name="Exportar STEP", exact=True), output, step=True)
    project = save_download(page, page.get_by_role("button", name="Guardar proyecto", exact=True), output)
    saved = json.loads(project.read_text())
    assert saved["schema"] == "edu3d-project" and saved["params"]["height"] == edited
    page.reload(wait_until="networkidle")
    expect(page.get_by_role("heading", name=re.compile("Dale nuevas medidas"))).to_be_visible()
    page.locator('input[type="file"][accept*=".json"]').set_input_files(str(project))
    expect(page.get_by_role("heading", name="Placa perforada", exact=True)).to_be_visible(timeout=180_000)
    idle(page)
    assert float(page.get_by_role("spinbutton", name="Altura en milímetros", exact=True).input_value()) == edited
    report["reopened_canvas"] = canvas_snapshot(page, output / "desktop-reopened-canvas.png", solid=True)
    report["demo"] = {"original_height": original, "edited_height": edited, "undo_redo": True,
                      "step": step.name, "step_bytes": step.stat().st_size, "project": project.name, "reopened": True}


def solid_volume(page: Page) -> float:
    metric = page.locator(".metric-row").filter(has=page.get_by_text("Volumen", exact=True))
    return float(metric.locator("strong").inner_text().split()[0].replace(".", "").replace(",", "."))


def operation_flow(page: Page, output: Path, report: dict) -> None:
    destination = output / "operations"
    destination.mkdir(exist_ok=True)
    original_volume = solid_volume(page)
    page.get_by_role("button", name="Taladro", exact=True).click()
    editor = page.locator(".operation-editor")
    expect(editor).to_be_visible()
    page.get_by_role("button", name="Situar en pieza", exact=True).click()
    canvas = page.locator(".viewer canvas")
    bounds = canvas.bounding_box()
    assert bounds
    canvas.click(position={"x": bounds["width"] * .5, "y": bounds["height"] * .5})
    expect(page.get_by_role("button", name="Situar en pieza", exact=True)).to_be_visible()
    # Choose an independent through-hole, away from the demo's original hole.
    for label, value in (("Centro X", "-10"), ("Centro Y", "0"), ("Diámetro", "4"), ("Longitud / altura", "20")):
        page.get_by_role("spinbutton", name=f"{label} de operación en milímetros", exact=True).fill(value)
    x_axis = editor.locator(".axis-selector button").filter(has_text=re.compile(r"^X$"))
    x_axis.click()
    expect(x_axis).to_have_class(re.compile(r"active"))
    editor.locator(".axis-selector button").filter(has_text=re.compile(r"^Z$")).click()
    page.get_by_role("button", name="Aplicar operación", exact=True).click()
    idle(page)
    expect(page.locator(".added-operation-row")).to_have_count(1)
    cut_volume = solid_volume(page)
    assert cut_volume < original_volume - .05, (original_volume, cut_volume)
    page.get_by_role("button", name="Editar operación 1: Taladro", exact=True).click()
    page.get_by_role("spinbutton", name="Diámetro de operación en milímetros", exact=True).fill("6")
    page.get_by_role("button", name="Guardar operación", exact=True).click()
    idle(page)
    edited_volume = solid_volume(page)
    assert edited_volume < cut_volume - .05, (cut_volume, edited_volume)

    page.get_by_role("button", name="Añadir bloque", exact=True).click()
    for label, value in (("Centro X", "-25"), ("Centro Y", "0"), ("Ancho", "8"), ("Fondo", "8"), ("Longitud / altura", "8")):
        page.get_by_role("spinbutton", name=f"{label} de operación en milímetros", exact=True).fill(value)
    page.get_by_role("button", name="Aplicar operación", exact=True).click()
    idle(page)
    expect(page.locator(".added-operation-row")).to_have_count(2)
    added_volume = solid_volume(page)
    assert added_volume > edited_volume + .05, (edited_volume, added_volume)
    page.get_by_role("button", name="Deshacer", exact=True).click()
    idle(page)
    expect(page.locator(".added-operation-row")).to_have_count(1)
    page.get_by_role("button", name="Rehacer", exact=True).click()
    idle(page)
    expect(page.locator(".added-operation-row")).to_have_count(2)
    page.get_by_role("button", name="Editar operación 1: Taladro", exact=True).click()
    page.get_by_role("button", name="Eliminar operación", exact=True).click()
    idle(page)
    expect(page.locator(".added-operation-row")).to_have_count(1)
    page.get_by_role("button", name="Deshacer", exact=True).click()
    idle(page)
    expect(page.locator(".added-operation-row")).to_have_count(2)

    project = save_download(page, page.get_by_role("button", name="Guardar proyecto", exact=True), destination)
    saved = json.loads(project.read_text())
    assert len(saved["operations"]) == 2
    assert saved["operations"][0]["mode"] == "cut" and saved["operations"][0]["parameters"]["diameter"] == 6
    assert saved["operations"][1]["mode"] == "add" and saved["operations"][1]["shape"] == "box"
    page.reload(wait_until="networkidle")
    page.locator('input[type="file"][accept*=".json"]').set_input_files(str(project))
    expect(page.get_by_role("heading", name="Placa perforada", exact=True)).to_be_visible(timeout=180_000)
    idle(page)
    expect(page.locator(".added-operation-row")).to_have_count(2)
    assert abs(solid_volume(page) - added_volume) < .002
    expect(page.get_by_text("Válido", exact=True)).to_be_visible()
    step = save_download(page, page.get_by_role("button", name="Exportar STEP", exact=True), destination, step=True)
    report["operations_canvas"] = canvas_snapshot(page, destination / "desktop-operations-canvas.png", solid=True)
    capture_page(page, destination / "desktop-operations-reopened.png")
    report["operations"] = {"surface_picking": True, "cut_edited": True, "addition": True,
                            "delete_undo_redo": True, "project_reopened": True,
                            "volumes_cm3": [original_volume, cut_volume, edited_volume, added_volume],
                            "project": str(project.relative_to(output)), "step": str(step.relative_to(output))}


def sample_flow(page: Page, sample: Path, output: Path, report: dict) -> None:
    assert sample.is_file(), f"STL sample not found: {sample}"
    triangles = stl_triangle_count(sample)
    page.locator('input[type="file"][accept=".stl"]').set_input_files(str(sample))
    expect(page.locator(".document-title")).to_have_text(sample.stem, timeout=180_000)
    idle(page)
    metric = page.locator(".metric-row").filter(has=page.get_by_text("Triángulos", exact=True))
    assert int(re.sub(r"\D", "", metric.locator("strong").inner_text())) == triangles
    capture_page(page, output / "desktop-sample-imported.png")
    convert = page.get_by_role("button", name="Crear sólido STEP", exact=True)
    faceted = bool(convert.count())
    if faceted:
        convert.click()
        expect(page.get_by_role("heading", name="Sólido de referencia", exact=True)).to_be_visible(timeout=180_000)
    idle(page)
    expect(page.get_by_text("Válido", exact=True)).to_be_visible()
    fields = page.locator('.properties-panel input[type="number"]')
    assert fields.count() > 0, "The sample has no editable dimensions"
    dimensions = {field.get_attribute("aria-label"): float(field.input_value()) for field in fields.all()}
    if faceted:
        assert len(dimensions) == 3 and all(value > 0 for value in dimensions.values())
        expect(page.locator(".section-title").filter(has_text=re.compile(r"^DIMENSIONES GLOBALES"))).to_be_visible()
    report["sample_canvas"] = canvas_snapshot(page, output / "desktop-sample-canvas.png", solid=True)
    capture_page(page, output / "desktop-sample-solid.png")
    step = save_download(page, page.get_by_role("button", name="Exportar STEP", exact=True), output, step=True)
    project = save_download(page, page.get_by_role("button", name="Guardar proyecto", exact=True), output)
    saved = json.loads(project.read_text())
    kind = saved["recognition"]["kind"]
    assert (kind == "mesh") == faceted
    assert len(saved["sourceMesh"]["faces"]) == triangles
    assert all(value > 0 for key, value in saved["params"].items() if key not in ("hole_x", "hole_y"))
    title = {"box": "Bloque", "cylinder": "Cilindro", "tube": "Tubo", "plate": "Placa perforada", "mesh": "Sólido de referencia"}[kind]
    page.reload(wait_until="networkidle")
    page.locator('input[type="file"][accept*=".json"]').set_input_files(str(project))
    expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible(timeout=180_000)
    idle(page)
    expect(page.locator(".document-title")).to_have_text(sample.stem)
    expect(page.get_by_text("Válido", exact=True)).to_be_visible()
    for label, value in dimensions.items():
        assert float(page.get_by_role("spinbutton", name=label, exact=True).input_value()) == value
    report["sample_reopened_canvas"] = canvas_snapshot(page, output / "desktop-sample-reopened-canvas.png", solid=True)
    capture_page(page, output / "desktop-sample-reopened.png")
    report["sample"] = {"filename": sample.name, "triangles": triangles, "valid": True,
                        "kind": kind, "global_dimensions": faceted, "step": step.name, "step_bytes": step.stat().st_size,
                        "project": project.name, "project_bytes": project.stat().st_size, "reopened": True}


def stl_triangle_count(path: Path) -> int:
    data = path.read_bytes()
    if len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        if count and len(data) == 84 + 50 * count:
            return count
    count = len(re.findall(rb"(?im)^\s*endfacet\s*$", data))
    assert count, "The sample is not a binary or ASCII STL with triangles"
    return count


def project_operation_flow(page: Page, project: Path, output: Path, report: dict) -> None:
    saved = json.loads(project.read_text())
    operations = saved.get("operations", [])
    assert operations and operations[0]["shape"] == "cylinder", "The supplied project must have a cylindrical detail"
    destination = output / "sample-operation"
    destination.mkdir(exist_ok=True)
    is_model = lambda response: response.url.endswith("/api/model") and response.request.method == "POST"
    with page.expect_response(is_model, timeout=180_000) as initial:
        page.locator('input[type="file"][accept*=".json"]').set_input_files(str(project))
    assert initial.value.ok
    initial_volume = initial.value.json()["volume"]
    idle(page)
    expect(page.locator(".added-operation-row")).to_have_count(len(operations))
    page.locator(".added-operation-row").first.click()
    diameter = page.get_by_role("spinbutton", name="Diámetro de operación en milímetros", exact=True)
    old_value = float(diameter.input_value())
    assert abs(old_value - operations[0]["parameters"]["diameter"]) < .0001
    new_value = round(old_value * 1.125, 6)
    diameter.fill(str(new_value))
    with page.expect_response(is_model, timeout=180_000) as rebuilt:
        page.get_by_role("button", name="Guardar operación", exact=True).click()
    assert rebuilt.value.ok
    final_volume = rebuilt.value.json()["volume"]
    assert final_volume < initial_volume if operations[0]["mode"] == "cut" else final_volume > initial_volume
    idle(page)
    expect(page.get_by_text("Válido", exact=True)).to_be_visible()
    edited_project = save_download(page, page.get_by_role("button", name="Guardar proyecto", exact=True), destination)
    edited = json.loads(edited_project.read_text())
    assert edited["operations"][0]["parameters"]["diameter"] == new_value
    step = save_download(page, page.get_by_role("button", name="Exportar STEP", exact=True), destination, step=True)
    page.reload(wait_until="networkidle")
    with page.expect_response(is_model, timeout=180_000):
        page.locator('input[type="file"][accept*=".json"]').set_input_files(str(edited_project))
    idle(page)
    expect(page.locator(".added-operation-row")).to_have_count(len(operations))
    page.locator(".added-operation-row").first.click()
    assert float(diameter.input_value()) == new_value
    report["imported_operation_canvas"] = canvas_snapshot(page, destination / "desktop-edited-canvas.png", solid=True)
    capture_page(page, destination / "desktop-edited-project.png")
    report["imported_operation_project"] = {"source": project.name, "diameter_before": old_value,
        "diameter_after": new_value, "volume_before_mm3": initial_volume, "volume_after_mm3": final_volume,
        "reopened": True, "project": str(edited_project.relative_to(output)), "step": str(step.relative_to(output))}


def mobile_flow(browser, base_url: str, output: Path, report: dict, errors: list[dict]) -> None:
    context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True,
                                  has_touch=True, device_scale_factor=1)
    page = context.new_page()
    add_error_listeners(page, errors)
    page.goto(base_url, wait_until="networkidle")
    report["mobile_empty_sizes"] = no_horizontal_overflow(page)
    capture_page(page, output / "mobile-empty.png")
    page.get_by_role("button", name="Probar pieza de ejemplo").click()
    expect(page.get_by_role("heading", name="Placa perforada", exact=True)).to_be_visible(timeout=180_000)
    idle(page)
    report["mobile_demo_sizes"] = no_horizontal_overflow(page)
    report["mobile_canvas"] = canvas_snapshot(page, output / "mobile-demo-canvas.png", solid=True)
    capture_page(page, output / "mobile-demo.png")
    page.evaluate("() => window.scrollTo(0, 0)")
    page.screenshot(path=str(output / "mobile-demo-viewport.png"))
    context.close()


def main() -> int:
    args = arguments()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"base_url": args.base_url, "status": "running", "errors": [], "checks": []}
    started = monotonic()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True,
                                             args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        context = browser.new_context(viewport={"width": 1536, "height": 960}, accept_downloads=True)
        page = context.new_page()
        add_error_listeners(page, report["errors"])
        page.set_default_timeout(15_000)
        try:
            response = page.goto(args.base_url, wait_until="networkidle")
            assert response and response.ok, "The application did not load"
            demo_flow(page, output, report)
            report["checks"].append("desktop_empty_demo_edit_undo_redo_step_project_roundtrip")
            if args.operations:
                operation_flow(page, output, report)
                report["checks"].append("surface_pick_cut_edit_add_delete_undo_redo_operations_roundtrip_step")
            if args.sample:
                sample_flow(page, args.sample.resolve(), output, report)
                report["checks"].append("personal_stl_import_conversion_and_step_download")
            if args.project:
                project_operation_flow(page, args.project.resolve(), output, report)
                report["checks"].append("imported_project_detail_edit_and_roundtrip")
            mobile_flow(browser, args.base_url, output, report, report["errors"])
            report["checks"].append("mobile_layout_and_webgl_render")
            assert not report["errors"], f"Browser errors: {report['errors']}"
            report["status"] = "passed"
            (output / "failure.png").unlink(missing_ok=True)
        except Exception:
            report["status"] = "failed"
            report["failure"] = traceback.format_exc()
            page.screenshot(path=str(output / "failure.png"), full_page=True)
            print(report["failure"])
        finally:
            report["seconds"] = round(monotonic() - started, 2)
            (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            context.close()
            browser.close()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
