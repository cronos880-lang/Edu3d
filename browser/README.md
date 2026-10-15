# Editor CAD autónomo Edu3d

Esta aplicación ejecuta OpenCascade en WebAssembly dentro de un Web Worker.
No necesita Python, servidor CAD ni conexión después de descargar el HTML.

```bash
cd browser
npm ci
npm run build
```

Abre `dist/Edu3d-Editor.html` en un navegador moderno con WebGL, WebAssembly,
Web Workers y DecompressionStream. La misma aplicación se publica en
`docs/index.html` y `docs/Edu3d-Editor.html` del repositorio.

El ejemplo inicial contiene un boceto con dos agujeros, una extrusión y un soporte
vertical. Edita el árbol para variar sus medidas, o crea un documento vacío.
El árbol se reconstruye en orden; un fallo detiene las operaciones posteriores y
bloquea exportación hasta corregirlo. Los proyectos `.edu3d.json` guardan el
historial y los archivos importados. STEP guarda sólidos, sin el historial de Edu3d.

La aplicación incluye bocetos rectangulares, circulares y poligonales con huecos,
extrusión, revolución, cajas, cilindros, esferas, operaciones booleanas, redondeo,
chaflán, vaciado, transformación con escala uniforme, patrones y simetría.
Los índices de caras y aristas seleccionadas se refieren a la topología anterior
a cada operación; después de modificar operaciones anteriores puede ser
necesario volver a seleccionar esas caras o aristas.

Un STL no contiene las operaciones originales. Su conversión produce un sólido
facetado al que se pueden aplicar operaciones nuevas; no recupera de forma
automática un historial CAD arbitrario. Es un editor personal de piezas, no una
implementación de todas las funciones industriales de Onshape.

Los archivos importados se procesan localmente; no se envían a servicios externos.
La memoria del navegador y la complejidad de la pieza limitan las operaciones.
Las licencias del motor y las dependencias están en `THIRD_PARTY_NOTICES.txt`.
