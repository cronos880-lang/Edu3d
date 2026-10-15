#!/usr/bin/env python3
"""Exercise the exact standalone HTML offline with the real browser CAD kernel.

Requires Playwright and system Chromium in the development environment. No web
server or cloud service is involved. Optional personal files stay outside Git.
"""
import argparse
import json
import re
from pathlib import Path
from time import monotonic

from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--html', type=Path, default=Path('browser/dist/index.html'))
    parser.add_argument('--output', type=Path, default=Path('/workspace/output/editor-validation'))
    parser.add_argument('--sample', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    started = monotonic()
    errors, requests, checks = [], [], []
    report = {'html': str(args.html.resolve()), 'checks': checks, 'errors': errors, 'external_requests': requests}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
            args=['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        context = browser.new_context(viewport={'width': 1536, 'height': 960}, accept_downloads=True, offline=True)
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('request', lambda r: requests.append(r.url) if r.url.startswith(('http:', 'https:')) else None)
        try:
            page.set_content(args.html.read_text(), wait_until='domcontentloaded', timeout=90_000)
            def idle():
                expect(page.locator('.progress-overlay')).to_have_count(0, timeout=240_000)
                expect(page.get_by_role('alert')).to_have_count(0)
                expect(page.locator('.feature.failed')).to_have_count(0)
            idle()
            expect(page.get_by_role('button', name='Exportar STEP', exact=True)).to_be_enabled()
            checks.append('Offline WASM startup and native parametric demo')
            page.screenshot(path=str(args.output/'editor-inicial.png'))
            # Edit an existing feature; this must rebuild solid geometry.
            page.locator('.feature-main').filter(has_text='Extrusión base').click()
            page.get_by_label('Distancia', exact=False).first.fill('9')
            page.get_by_role('button', name='Aplicar operación').click()
            idle()
            checks.append('Edit extrusion parameter and rebuild dependent solid')
            page.get_by_role('button', name='↶ Deshacer', exact=True).click()
            idle()
            page.get_by_role('button', name='↷ Rehacer', exact=True).click()
            idle()
            checks.append('Undo and redo parameter change')
            # Native STEP, not a renamed triangle file.
            with page.expect_download(timeout=120_000) as item:
                page.get_by_role('button', name='Exportar STEP', exact=True).click()
            item.value.save_as(str(args.output/'demo-editado.step'))
            idle()
            data=(args.output/'demo-editado.step').read_text(errors='replace')
            assert data.startswith('ISO-10303-21;') and 'MANIFOLD_SOLID_BREP' in data
            checks.append('Native STEP export includes manifold solid BREP')
            with page.expect_download() as item:
                page.get_by_role('button', name='Guardar', exact=True).click()
            item.value.save_as(str(args.output/'demo.edu3d.json'))
            saved=json.loads((args.output/'demo.edu3d.json').read_text())
            assert saved['schema']=='edu3d-cad' and saved['features'][1]['distance']==9
            checks.append('Project saves feature history and edited parameter')
            page.locator('input[type=file][accept=".json,.edu3d.json"]').set_input_files(str(args.output/'demo.edu3d.json'))
            idle()
            expect(page.locator('.feature')).to_have_count(3)
            checks.append('Saved project reopens and rebuilds the same history')
            # A real boolean cut with an editable cylinder.
            page.get_by_role('button', name='▤ Cilindro', exact=True).click()
            page.get_by_label('Radio', exact=False).first.fill('2')
            page.get_by_label('Altura', exact=False).first.fill('30')
            page.get_by_label('Resultado', exact=True).select_option('cut')
            page.get_by_role('button', name='Aplicar operación').click()
            idle()
            checks.append('Cylinder subtracts material from the existing body')
            with page.expect_download(timeout=120_000) as item:
                page.get_by_role('button', name='Exportar STEP', exact=True).click()
            item.value.save_as(str(args.output/'demo-corte.step'))
            idle()
            if args.sample:
                empty={'schema':'edu3d-cad','version':2,'name':'Prueba STL','units':'mm','assets':{},'features':[]}
                page.locator('input[type=file][accept=".json,.edu3d.json"]').set_input_files({'name':'nuevo.edu3d.json','mimeType':'application/json','buffer':json.dumps(empty).encode()})
                expect(page.get_by_label('Nombre del proyecto')).to_have_value('Prueba STL')
                idle()
                page.locator('input[type=file][accept=".stl,.step,.stp"]').set_input_files(str(args.sample))
                idle()
                expect(page.locator('.body-item').filter(has_text=args.sample.name)).to_have_count(1,timeout=240_000)
                with page.expect_download(timeout=240_000) as item:
                    page.get_by_role('button', name='Exportar STEP', exact=True).click()
                item.value.save_as(str(args.output/'importado.step'))
                idle()
                checks.append('Personal STL imports as solid and exports native STEP offline')
                if args.sample.name=='Sidewinder - Part 1.stl':
                    page.locator('.body-item').filter(has_text=args.sample.name).click()
                    page.get_by_role('button', name='▤ Cilindro', exact=True).click()
                    page.get_by_label('Radio', exact=False).first.fill('0.9')
                    page.get_by_label('Altura', exact=False).first.fill('14')
                    center=page.get_by_role('group',name='Centro (mm)',exact=True)
                    for axis,value in zip('XYZ',[223.86512133879583,-25.42213490204892,6]):
                        center.get_by_label(axis,exact=True).fill(str(value))
                    page.get_by_label('Resultado',exact=True).select_option('cut')
                    page.get_by_role('button', name='Aplicar operación').click()
                    idle()
                    with page.expect_download(timeout=240_000) as item:
                        page.get_by_role('button',name='Exportar STEP',exact=True).click()
                    item.value.save_as(str(args.output/'importado-editado.step'))
                    idle()
                    checks.append('Editable native cylindrical cut on the imported personal STL')
                    page.locator('.feature-main').last.click()
                    page.get_by_label('Radio',exact=False).first.fill('1.0')
                    page.get_by_role('button',name='Aplicar operación').click()
                    idle()
                    with page.expect_download(timeout=240_000) as item:
                        page.get_by_role('button',name='Exportar STEP',exact=True).click()
                    item.value.save_as(str(args.output/'importado-radio-1.step'))
                    idle()
                    with page.expect_download() as item:
                        page.get_by_role('button',name='Guardar',exact=True).click()
                    item.value.save_as(str(args.output/'STL-editable.edu3d.json'))
                    project=json.loads((args.output/'STL-editable.edu3d.json').read_text())
                    assert project['features'][-1]['radius']==1 and len(project['assets'])==1
                    checks.append('STL operation radius edits parametrically from 0.9 to 1.0 mm and project retains imported asset')
            page.screenshot(path=str(args.output/'editor-final.png'))
            assert not errors, errors
            assert not requests, requests
            report['passed']=True
        except Exception as e:
            report['passed']=False
            report['failure']=str(e)
            page.screenshot(path=str(args.output/'fallo.png'))
            raise
        finally:
            report['duration_seconds']=round(monotonic()-started,2)
            (args.output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
            browser.close()
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
