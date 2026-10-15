# Validación del editor autónomo

Verificado el 15 de octubre de 2026:

- Compilación TypeScript estricta y generación del HTML autónomo de 10,4 MiB.
- **23 pruebas** con el mismo OpenCascade WebAssembly distribuido en el HTML:
  primitivas, bocetos y huecos, extrusión, revolución, booleanas, aristas/caras,
  redondeo, chaflán, vaciado, transformaciones, patrones, simetría, historial,
  errores, unidades, caché, importaciones y exportación STEP reimportada.
- **122 pruebas Python** de la aplicación y API existentes.
- Chromium sin conexión: inicio del motor, edición de parámetros y dependencias,
  deshacer/rehacer, guardado y reapertura de proyectos, corte real, importación
  STL y descarga STEP. Sin errores JavaScript ni peticiones externas.
- Selección por clic de caras y aristas, cuatro vistas distintas y medición real
  entre puntos. La GPU deja de dibujar cuando la escena está en reposo.
- Prueba con el adjunto personal de 11.072 triángulos: importación, corte
  cilíndrico, cambio del radio de 0,9 a 1 mm y exportación de ambos sólidos.
  El adjunto y los resultados privados se conservaron fuera de Git.
- Los STEP descargados desde el HTML se reimportaron con CadQuery/OpenCascade
  independiente: sólidos válidos, volúmenes coherentes y superficie cilíndrica
  real. La demostración también conserva el volumen exacto tras el corte.
- El servidor Python sirve el nuevo editor compilado en su ruta principal.

La prueba del HTML usa su contenido exacto en un navegador desconectado:
una política del Chromium administrado de este entorno bloquea la navegación
`file://`. No se modificaron políticas del navegador. El HTML no depende de
un servidor ni de recursos externos.

Para reproducir:

```bash
npm --prefix browser ci
npm --prefix browser run publish-html
npm --prefix browser test
.venv/bin/python -m pytest -q
python scripts/browser_editor_smoke.py --sample /ruta/a/una-pieza.stl
```

Un STL aporta triángulos, sin historial original. La versión permite crear y
editar operaciones nuevas sobre un sólido facetado; no recupera todas las
restricciones ni las operaciones originales de cualquier pieza y no implementa
todas las funciones industriales de Onshape.
