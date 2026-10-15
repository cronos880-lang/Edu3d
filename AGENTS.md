# Trabajo en Edu3d

- El editor principal está en `browser/`: OpenCascade WebAssembly y React, sin
  servidor CAD. La aplicación Python anterior se conserva como alternativa.
- Al entregar cambios del editor, **actualiza y sube también el HTML a GitHub**,
  según la preferencia explícita del propietario. Ejecuta `npm --prefix browser
  test`, después `npm --prefix browser run publish-html`, y publica el código y
  `docs/` juntos. No entregues únicamente el código fuente ni un HTML antiguo.
- El enlace de descarga estable es
  `https://github.com/cronos880-lang/Edu3d/raw/refs/heads/main/docs/Edu3d-Editor.html`.
  No presentes una dirección de GitHub Pages como activa sin comprobarla.
- No subas STL, STEP ni proyectos personales del usuario. La demostración del
  HTML se construye con operaciones nativas y no contiene sus adjuntos.
- Usa el núcleo real para validar sólidos y STEP. Un STL facetado no contiene
  el historial CAD original; no describas su conversión como recuperación
  automática de parámetros de cualquier pieza.
- Si cambias Python, ejecuta `.venv/bin/python -m pytest -q`. Para comprobar el
  HTML offline usa `python scripts/browser_editor_smoke.py`; `--sample` acepta
  un adjunto local sin copiarlo al repositorio.
