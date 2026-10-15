# Edu3d

## Editor CAD en un único HTML

La versión más reciente ejecuta el motor CAD **OpenCascade dentro del navegador**.
No necesita instalar Python ni iniciar un servidor.

**[Descargar Edu3d-Editor.html](https://github.com/cronos880-lang/Edu3d/raw/refs/heads/main/docs/Edu3d-Editor.html)**

Descarga el archivo y ábrelo en Chrome, Edge, Firefox o Safari actualizado.
El HTML incluye el motor CAD y funciona sin conexión. El ejemplo inicial es
editable desde el árbol: boceto, agujeros, extrusión y soporte vertical.

Incluye bocetos con dimensiones, extrusión, revolución, primitivas, booleanas,
redondeo, chaflán, vaciado, movimiento, escala uniforme, patrones y simetría;
importación STL/STEP, exportación STEP/STL, proyectos, historial y deshacer/rehacer.
Los STL cerrados se convierten a sólidos facetados sobre los que se pueden crear
operaciones. No se recupera automáticamente el historial original de cualquier STL.

Código y compilación: [browser/README.md](browser/README.md).
El HTML publicado se conserva en `docs/` junto al código de cada versión.
Para servirlo con GitHub Pages, el origen de publicación es `main`, carpeta `/docs`.

La documentación siguiente corresponde también a la aplicación Python original.

Un entorno CAD personal para preparar piezas de impresión 3D: importar un STL,
inspeccionarlo, crear un sólido editable y exportar geometría STEP real mediante
OpenCascade. Interfaz en español, visor Three.js y motor CadQuery en Python.

## Primera versión

- Importación STL binaria o ASCII, en mm, cm o pulgadas. STL no almacena unidades;
  hay que indicar las unidades del archivo al importarlo. Internamente se usan mm.
- Visor 3D con órbita, zoom, vistas, rejilla y comparación entre referencia y sólido.
- Inspección de dimensiones, volumen y cierre de la malla.
- Reconstrucción analítica conservadora de cajas, cilindros, tubos y placas
  rectangulares con un taladro pasante: sus medidas se pueden editar por separado.
- Para otras piezas cerradas: creación explícita de un **sólido de referencia
  faceteado**, con dimensiones globales editables y exportación STEP/STL.
- Operaciones nuevas sobre el sólido: añadir o recortar bloques y cilindros,
  con posición, dimensiones y eje editables. El árbol permite editar o eliminar
  operaciones y reconstruye el resultado en orden.
- Guardado y apertura de proyectos `.edu3d.json`, que conservan referencia y
  parámetros. Deshacer y rehacer los cambios de medidas en la sesión.

**STEP conserva la geometría, no el árbol de operaciones de Edu3d.** El proyecto
JSON conserva los parámetros propios de esta aplicación. El STL no contiene los
bocetos, restricciones ni operaciones originales; esta versión no los recupera.
En una conversión faceteada, cambiar ancho, fondo o alto escala también agujeros,
paredes y demás detalles. Sus superficies curvas siguen compuestas por facetas.
Para editar cada agujero o cada pared de un STL complejo de forma independiente
será necesaria una reconstrucción guiada de operaciones. Esta versión permite
añadir material y volver a cortarlo con medidas nuevas; no convierte los
detalles originales en un árbol CAD editable de forma automática.

## Instalación

Requiere Python 3.12, Node.js 24 y npm. Desde la raíz del checkout:

```bash
bash scripts/setup.sh
```

El script crea `.venv`, instala las versiones y hashes de `requirements.txt`,
ejecuta `npm ci` con el lockfile y compila la interfaz. Usa `uv` cuando está
disponible y `pip` como alternativa. Se puede repetir sin borrar proyectos.
No requiere cuentas, claves ni servicios externos para trabajar con las piezas.

## Abrir la aplicación desde GitHub

La aplicación completa se puede ejecutar en **GitHub Codespaces**, con el motor
CAD y la interfaz en el mismo espacio. La aplicación Python necesita ese servidor;
el editor HTML autónomo de `docs/` sí funciona en GitHub Pages.

[Crear un Codespace de Edu3d](https://codespaces.new/cronos880-lang/Edu3d)

1. En el repositorio de GitHub abre **Code → Codespaces → Create codespace on main**.
2. Espera a que se instalen las dependencias y se compile la interfaz.
3. El puerto **8000 — Edu3d** se abre automáticamente en el navegador. Si no se
   abre, entra en **Ports / Puertos** y pulsa el icono de abrir en el navegador.
4. Guarda la dirección que GitHub asigne a ese puerto para volver a la aplicación.

El puerto es privado por defecto: entra con tu cuenta de GitHub y conserva esa
visibilidad. El Codespace debe estar activo para que la dirección responda. Puedes
reiniciarlo desde GitHub; `scripts/codespaces-start.sh` vuelve a arrancar Edu3d y
comprueba su disponibilidad. Los archivos del proyecto y el entorno se conservan
en el Codespace, pero guarda tus proyectos `.edu3d.json` antes de cerrar la pestaña.

Codespaces está sujeto a la cuota y facturación de tu cuenta. Revisa la cuota al
crear el espacio y detenlo cuando termines de usarlo. El archivo de configuración
no crea un Codespace ni contrata un plan por sí solo.

## Arranque

```bash
bash scripts/start.sh
```

Sirve la interfaz compilada y la API en el puerto local 8000. `PORT` permite
cambiarlo. El proceso debe arrancarse de nuevo en cada sesión: una instantánea
del entorno conserva archivos y dependencias, pero no procesos vivos.

Para desarrollar con recarga, desde la raíz ejecuta la API:

```bash
.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

En otra terminal ejecuta `npm --prefix frontend run dev`; Vite usa el puerto
5173 y reenvía `/api` a la API. La aplicación está pensada para uso personal.

## Flujo de trabajo

1. Selecciona las unidades e importa el STL, o prueba la placa de ejemplo.
2. Revisa dimensiones y avisos antes de reconstruir.
3. Si se reconoce una forma sencilla, ajusta sus parámetros y aplica los cambios.
   Si no se reconoce, usa «Crear sólido STEP» para crear una referencia faceteada.
4. Compara la malla y el sólido con los controles de visibilidad.
5. Añade taladros, cortes rectangulares o material nuevo. Sitúa el centro en
   coordenadas globales y ajusta las medidas antes de aplicar. Los cilindros
   pueden orientarse en X, Y o Z; los bloques siguen los ejes globales.
6. Guarda el proyecto JSON para seguir editando; exporta STEP para otro CAD o STL
   para el laminador.

Límites: 20 MiB por archivo y 250.000 triángulos para inspección. La conversión
faceteada está limitada a 25.000 triángulos y requiere un único cuerpo cerrado,
manifold y con orientación consistente. Las mallas defectuosas se pueden revisar,
pero hay que repararlas antes de crear un sólido. Se permiten hasta 12 operaciones
nuevas por modelo; cada una debe dejar un único sólido válido. Las operaciones
no tienen restricciones ni relaciones automáticas con los detalles del STL.
Los modelos viven en el navegador hasta guardarlos: exporta el proyecto antes de
cerrar o recargar.

## Validación

```bash
.venv/bin/python -m pytest -q
npm --prefix frontend run build
```

Las pruebas comprueban reconocimiento y rechazos, validez topológica, unidades,
edición de dimensiones y exportación STEP reimportada con medidas y volumen
esperados. La prueba del navegador utiliza Chromium y Playwright disponibles en
el entorno de desarrollo; el funcionamiento del motor no necesita un navegador.

Con la aplicación arrancada, la comprobación completa de interfaz es:

```bash
python scripts/browser_smoke.py --operations --output /workspace/output/browser-check
```

Se puede añadir `--sample "/ruta/a/una-pieza.stl"` para comprobar un STL cerrado
propio. El script guarda capturas y descargas fuera del código fuente. En este
entorno se han verificado escritorio, móvil, posicionamiento por clic, edición y
eliminación de operaciones, deshacer/rehacer y proyectos guardados y reabiertos.

## Estructura

- `backend/geometry.py`: lectura STL, reconocimiento y modelos analíticos.
- `backend/mesh_solid.py`: referencia faceteada, escala y exportación.
- `backend/operations.py`: secuencia de operaciones booleanas nuevas y validación.
- `backend/main.py`: API y publicación de la interfaz compilada.
- `frontend/src/`: interfaz, visor y proyectos locales.
- `tests/`: pruebas geométricas y del contrato HTTP.
- `.devcontainer/`: entorno de GitHub Codespaces y reenvío del puerto de la app.
- `deploy/entrypoint.py`: acceso con contraseña para otros alojamientos públicos.

El wrapper de despliegue externo se arranca con
`uvicorn deploy.entrypoint:create_app_from_env --factory`. Requiere la variable
secreta `EDU3D_PASSWORD` en los ajustes seguros del alojamiento; el usuario por
defecto es `edu3d` (`EDU3D_USER` lo cambia). Protege interfaz, API y archivos,
dejando pública únicamente la salud. Úsalo detrás de HTTPS. Codespaces usa la
aplicación normal con el puerto privado de GitHub y no necesita esa contraseña.

Los archivos STL personales y los resultados generados no se incluyen como
ejemplos del repositorio. Los resultados locales de validación van fuera del
checkout o en `.local/`, ignorado por Git.
