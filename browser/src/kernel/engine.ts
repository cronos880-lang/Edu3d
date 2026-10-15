import {
  cast, exportSTEP, FaceFinder, getOC, HASH_CODE_MAX, isShape3D, makeBox, makeCompound,
  makeCylinder, makeSphere, measureArea, measureVolume,
  type AnyShape, type Shape3D, type EdgeFinder, type Edge, type Face, type Solid,
} from 'replicad';
import type {
  CadDocument, CadProgress, BuildResult, ExportResult, Feature, FeatureStatus,
  RenderBody, SketchFeature, Vec3, Mode,
} from '../types';
import { importAsset } from './importers';
import { buildSketch, disposeSketch } from './sketches';

type Body = { shape: Shape3D; name: string; imported?: boolean };
const ZERO: Vec3 = [0, 0, 0];
const AXES: Record<string, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const NORMALS: Record<string, Vec3> = { XY: [0, 0, 1], XZ: [0, -1, 0], YZ: [1, 0, 0] };

function fail(message: string): never { throw new Error(message); }
function number(value: unknown, label: string, minimum = -1e6, maximum = 1e6): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)
    fail(`${label}: introduce un número finito entre ${minimum} y ${maximum}.`);
  return value;
}
function dimension(value: unknown, label: string): number { return number(value, label, 0.001, 100000); }
function vector(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) fail(`${label}: se requieren tres coordenadas.`);
  return value.map((v, i) => number(v, `${label} ${'XYZ'[i]}`)) as Vec3;
}
function direction(value: unknown): Vec3 {
  const v = vector(value, 'Dirección');
  const length = Math.hypot(...v);
  if (length < 1e-9) fail('La dirección no puede ser nula.');
  return v.map(x => x / length) as Vec3;
}
function release(shape: { delete(): void } | undefined | null): void {
  if (shape) { try { shape.delete(); } catch { /* Already consumed by a Replicad transform. */ } }
}
function topology(shape: Shape3D, kind: 'edge'): Edge[];
function topology(shape: Shape3D, kind: 'face'): Face[];
function topology(shape: Shape3D, kind: 'solid'): Solid[];
function topology(shape: Shape3D, kind: 'edge' | 'face' | 'solid'): (Edge | Face | Solid)[] {
  const oc = getOC();
  const type = kind === 'edge' ? oc.TopAbs_ShapeEnum.TopAbs_EDGE : kind === 'face' ? oc.TopAbs_ShapeEnum.TopAbs_FACE : oc.TopAbs_ShapeEnum.TopAbs_SOLID;
  const explorer = new oc.TopExp_Explorer(shape.wrapped, type, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const result: (Edge | Face | Solid)[] = [];
  const buckets = new Map<number, (Edge | Face | Solid)[]>();
  try {
    while (explorer.More()) {
      const item = explorer.Current();
      try {
        const hash = oc.ReplicadShapeHasher.HashCode(item, HASH_CODE_MAX);
        const bucket = buckets.get(hash) || [];
        if (!bucket.some(previous => previous.wrapped.IsSame(item))) {
          const wrapped = cast(item) as Edge | Face | Solid;
          bucket.push(wrapped); buckets.set(hash, bucket); result.push(wrapped);
        }
      } finally { item.delete(); }
      explorer.Next();
    }
    return result;
  } catch (error) { result.forEach(release); throw error; }
  finally { explorer.delete(); }
}
function countSolids(shape: Shape3D): number {
  const solids = topology(shape, 'solid');
  const count = solids.length;
  solids.forEach(release);
  return count;
}
function valid(shape: AnyShape): asserts shape is Shape3D {
  if (shape.isNull || !isShape3D(shape)) fail('La operación no ha producido un sólido CAD.');
  const checker = new (getOC()).BRepCheck_Analyzer(shape.wrapped, true, false, false);
  try { if (!checker.IsValid()) fail('El núcleo CAD rechaza el resultado: geometría no válida.'); }
  finally { checker.delete(); }
  if (!countSolids(shape)) fail('La operación ha dejado la pieza sin sólidos.');
  const volume = measureVolume(shape);
  if (!Number.isFinite(volume) || volume <= 1e-10) fail('El resultado no conserva volumen positivo.');
}
function selectedHashes(shape: Shape3D, indices: number[] | undefined, kind: 'edge' | 'face'): Set<number> | undefined {
  if (indices === undefined) return undefined;
  if (!Array.isArray(indices) || !indices.length) fail(`Selecciona al menos una ${kind === 'edge' ? 'arista' : 'cara'}.`);
  const elements = kind === 'edge' ? topology(shape, 'edge') : topology(shape, 'face');
  try {
    const selected = new Set<number>();
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= elements.length)
        fail('La selección ya no existe en este punto del historial. Vuelve a seleccionar la geometría.');
      selected.add(elements[index].hashCode);
    }
    return selected;
  } finally { elements.forEach(release); }
}
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'El núcleo CAD no pudo completar esta operación. Revisa las dimensiones y la selección.';
}

/** Actual OpenCascade solids live in this worker; render meshes are only previews. */
export class CadEngine {
  private bodies = new Map<string, Body>();
  private exportable = false;

  async build(document: CadDocument, onProgress?: (p: CadProgress) => void): Promise<BuildResult> {
    const start = performance.now();
    this.exportable = false;
    if (!document || document.schema !== 'edu3d-cad' || document.version !== 2 || document.units !== 'mm'
        || !Array.isArray(document.features) || document.features.length > 200)
      fail('Documento CAD no válido: se admiten hasta 200 operaciones y unidades internas mm.');
    if (!document.assets || typeof document.assets !== 'object' || Object.keys(document.assets).length > 32)
      fail('El documento admite hasta 32 archivos importados.');
    let next = new Map<string, Body>();
    const sketches = new Map<string, SketchFeature>();
    const statuses: FeatureStatus[] = [];
    const warnings: string[] = [];
    const ids = new Set<string>();
    let failed = false;
    const body = (id: string | undefined): Body => {
      if (!id || !next.has(id)) fail('No se encuentra el cuerpo de destino en este punto del historial.');
      return next.get(id)!;
    };
    const commit = (id: string, candidate: AnyShape, name: string, imported?: boolean, checked = false): void => {
      try {
        if (!checked) valid(candidate);
        if (!isShape3D(candidate)) fail('La operación no ha producido un sólido CAD.');
        if (!next.has(id) && next.size >= 64) fail('Se admite un máximo de 64 cuerpos por documento.');
        const previous = next.get(id);
        next.set(id, { shape: candidate, name, imported });
        if (previous?.shape !== candidate) release(previous?.shape);
      } catch (error) { release(candidate); throw error; }
    };
    const combine = (feature: Feature & { mode: Mode; target?: string }, tool: Shape3D): void => {
      if (feature.mode === 'new') { commit(feature.id, tool, feature.name); return; }
      try {
        const target = body(feature.target);
        const candidate = this.boolean(target.shape, tool, feature.mode, target.imported);
        commit(feature.target!, candidate, target.name, target.imported, true);
      } finally { release(tool); }
    };
    for (let index = 0; index < document.features.length; index++) {
      const feature = document.features[index];
      if (failed) { statuses.push({ id: feature.id, status: 'skipped', message: 'Una operación anterior ha fallado.' }); continue; }
      if (feature.suppressed) { statuses.push({ id: feature.id, status: 'suppressed' }); continue; }
      onProgress?.({ stage: `Calculando ${feature.name || feature.type}`, progress: index / Math.max(1, document.features.length) });
      try {
        if (typeof feature.id !== 'string' || !feature.id || ids.has(feature.id)) fail('Cada operación necesita un identificador único.');
        ids.add(feature.id);
        switch (feature.type) {
          case 'primitive': {
            const center = vector(feature.center, 'Centro');
            let shape: Shape3D;
            if (feature.kind === 'box') {
              const sizes = [dimension(feature.width, 'Anchura'), dimension(feature.depth, 'Profundidad'), dimension(feature.height, 'Altura')];
              shape = makeBox(center.map((v, i) => v - sizes[i] / 2) as Vec3, center.map((v, i) => v + sizes[i] / 2) as Vec3);
            } else if (feature.kind === 'cylinder') {
              const height = dimension(feature.height, 'Altura');
              shape = makeCylinder(dimension(feature.radius, 'Radio'), height, [center[0], center[1], center[2] - height / 2]);
            } else if (feature.kind === 'sphere') shape = makeSphere(dimension(feature.radius, 'Radio')).translate(center);
            else fail('Primitiva no admitida.');
            combine(feature, shape);
            break;
          }
          case 'sketch': {
            const sketch = buildSketch(feature);
            disposeSketch(sketch);
            sketches.set(feature.id, feature);
            break;
          }
          case 'extrude': {
            const source = sketches.get(feature.sketchId);
            if (!source) fail('No se encuentra el croquis de la extrusión.');
            const distance = number(feature.distance, 'Distancia', -100000, 100000);
            if (Math.abs(distance) < .001) fail('La distancia de extrusión debe ser distinta de cero.');
            const sketch = buildSketch(source);
            let shape: AnyShape;
            try { shape = sketch.extrude(distance); }
            catch (error) { disposeSketch(sketch); throw error; }
            valid(shape);
            if (feature.symmetric) shape = shape.translate(NORMALS[source.plane].map(v => -v * distance / 2) as Vec3);
            combine(feature, shape.asShape3D());
            break;
          }
          case 'revolve': {
            const source = sketches.get(feature.sketchId);
            if (!source) fail('No se encuentra el croquis de la revolución.');
            const angle = number(feature.angle, 'Ángulo', -360, 360);
            if (Math.abs(angle) < .001) fail('El ángulo de revolución debe ser distinto de cero.');
            if (!AXES[feature.axis]) fail('Eje de revolución no válido.');
            const origin = vector(feature.origin, 'Origen del eje');
            const sketch = buildSketch(source);
            let shape: AnyShape;
            try { shape = sketch.revolve(AXES[feature.axis], { origin, angle }); }
            catch (error) { disposeSketch(sketch); throw error; }
            valid(shape);
            combine(feature, shape.asShape3D());
            break;
          }
          case 'import': {
            const asset = document.assets[feature.assetId];
            if (!asset) fail('No se encuentra el archivo importado del documento.');
            const imported = await importAsset(asset, onProgress);
            warnings.push(...imported.warnings);
            // importAsset owns its cache; the engine owns and deletes only this clone.
            commit(feature.id, imported.shape.clone(), feature.name || asset.name, true, true);
            break;
          }
          case 'transform': {
            const target = body(feature.target);
            const translation = vector(feature.translation, 'Desplazamiento');
            const rotation = vector(feature.rotation, 'Rotación');
            const scale = vector(feature.scale, 'Escala');
            scale.forEach(v => dimension(v, 'Escala'));
            if (Math.max(...scale) - Math.min(...scale) > 1e-10)
              fail('Este núcleo admite escala uniforme: introduce el mismo factor en X, Y y Z.');
            let candidate: Shape3D | null = target.shape.clone();
            try {
              if (scale[0] !== 1) candidate = candidate.scale(scale[0], ZERO);
              rotation.forEach((angle, i) => { if (angle) candidate = candidate!.rotate(angle, ZERO, AXES['XYZ'[i]]); });
              if (translation.some(v => v)) candidate = candidate.translate(translation);
              commit(feature.target, candidate, target.name, target.imported);
              candidate = null;
            } finally { release(candidate); }
            break;
          }
          case 'fillet': case 'chamfer': {
            const target = body(feature.target);
            const value = dimension(feature.type === 'fillet' ? feature.radius : feature.distance, feature.type === 'fillet' ? 'Radio' : 'Distancia');
            const hashes = selectedHashes(target.shape, feature.edges, 'edge');
            const filter = hashes ? (finder: EdgeFinder) => finder.when(({ element }) => hashes.has(element.hashCode)) : undefined;
            const candidate = feature.type === 'fillet' ? target.shape.fillet(value, filter) : target.shape.chamfer(value, filter);
            commit(feature.target, candidate, target.name, target.imported);
            break;
          }
          case 'shell': {
            const target = body(feature.target);
            const thickness = dimension(feature.thickness, 'Espesor');
            let hashes = selectedHashes(target.shape, feature.faces, 'face');
            if (!hashes) {
              const faces = topology(target.shape, 'face');
              try {
                let highest = -Infinity, chosen = -1;
                faces.forEach((face, i) => { const center = face.center; try { if (center.z > highest) { highest = center.z; chosen = i; } } finally { center.delete(); } });
                if (chosen < 0) fail('No se encuentra una cara para abrir el vaciado.');
                hashes = new Set([faces[chosen].hashCode]);
              } finally { faces.forEach(release); }
            }
            const filter = new FaceFinder().when(({ element }) => hashes!.has(element.hashCode));
            try { commit(feature.target, target.shape.shell({ filter, thickness }), target.name, target.imported); }
            finally { filter.delete(); }
            break;
          }
          case 'boolean': {
            if (feature.target === feature.tool) fail('El cuerpo herramienta debe ser distinto del destino.');
            const target = body(feature.target), tool = body(feature.tool);
            commit(feature.target, this.boolean(target.shape, tool.shape, feature.operation, target.imported || tool.imported), target.name, target.imported, true);
            if (!feature.keepTool) { release(tool.shape); next.delete(feature.tool); }
            break;
          }
          case 'pattern': {
            const target = body(feature.target);
            const count = number(feature.count, 'Número de repeticiones', 2, 64);
            if (!Number.isInteger(count)) fail('El número de repeticiones debe ser entero.');
            const axis = direction(feature.direction);
            const origin = vector(feature.origin, 'Origen');
            const distance = number(feature.distance, 'Separación', -100000, 100000);
            const angle = number(feature.angle, 'Ángulo', -360, 360);
            if (feature.kind !== 'linear' && feature.kind !== 'circular') fail('Patrón no admitido.');
            if (feature.kind === 'linear' && Math.abs(distance) < .001) fail('La separación del patrón debe ser distinta de cero.');
            if (feature.kind === 'circular' && Math.abs(angle) < .001) fail('El ángulo del patrón debe ser distinto de cero.');
            let candidate: Shape3D | null = target.shape.clone();
            try {
              for (let i = 1; i < count; i++) {
                let copy = target.shape.clone();
                copy = feature.kind === 'linear'
                  ? copy.translate(axis.map(v => v * distance * i) as Vec3)
                  : copy.rotate(angle * i / (Math.abs(angle) === 360 ? count : count - 1), origin, axis);
                try { const combined: Shape3D = candidate!.fuse(copy); release(candidate); candidate = combined; }
                finally { release(copy); }
              }
              commit(feature.target, candidate!, target.name, target.imported);
              candidate = null;
            } finally { release(candidate); }
            break;
          }
          case 'mirror': {
            const target = body(feature.target);
            if (!NORMALS[feature.plane]) fail('Plano de simetría no válido.');
            const offset = number(feature.offset, 'Desplazamiento del plano');
            let candidate: Shape3D | null = target.shape.clone().mirror(feature.plane, NORMALS[feature.plane].map(v => v * offset) as Vec3);
            try {
              if (feature.keepOriginal) { const combined = target.shape.fuse(candidate); release(candidate); candidate = combined; }
              commit(feature.target, candidate, target.name, target.imported);
              candidate = null;
            } finally { release(candidate); }
            break;
          }
          default: fail('Operación CAD no admitida.');
        }
        statuses.push({ id: feature.id, status: 'ok' });
      } catch (error) {
        failed = true;
        statuses.push({ id: feature.id, status: 'error', message: errorMessage(error) });
      }
    }
    if (failed && !next.size && this.bodies.size) {
      next = this.bodies;
      warnings.push('Se muestra el último resultado válido. Corrige el error para actualizar la pieza y exportar.');
    }
    onProgress?.({ stage: 'Preparando caras y aristas', progress: .95 });
    let rendered: RenderBody[];
    try { rendered = Array.from(next, ([id, value]) => this.render(id, value)); }
    catch (error) {
      for (const value of next.values()) if (next !== this.bodies) release(value.shape);
      throw new Error(`No se pudo representar el sólido: ${errorMessage(error)}`);
    }
    if (next !== this.bodies) for (const previous of this.bodies.values()) release(previous.shape);
    this.bodies = next;
    this.exportable = !failed && rendered.length > 0;
    onProgress?.({ stage: 'Documento calculado', progress: 1 });
    return { ok: !failed, bodies: rendered, features: statuses, warnings: [...new Set(warnings)], durationMs: performance.now() - start };
  }

  private boolean(target: Shape3D, tool: Shape3D, mode: Exclude<Mode, 'new'>, preferNative = false): Shape3D {
    if (!['add', 'cut', 'intersect'].includes(mode)) fail('Modo de operación no admitido.');
    let result: Shape3D | undefined;
    let checked = false;
    if (!preferNative) {
      try {
        result = mode === 'add' ? target.fuse(tool) : mode === 'cut' ? target.cut(tool) : target.intersect(tool);
        valid(result);
        checked = true;
      } catch { release(result); result = undefined; }
    }
    if (!result) {
      // Replicad unifies faces at an angular tolerance of .001 after boolean
      // operations. On finely faceted STL this can invalidate the result.
      // Retry the exact OCCT boolean without that optional simplification.
      const oc = getOC();
      const builder = mode === 'add' ? new oc.BRepAlgoAPI_Fuse() : mode === 'cut' ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Common();
      const argumentsList = new oc.NCollection_List_TopoDS_Shape();
      const toolsList = new oc.NCollection_List_TopoDS_Shape();
      try {
        argumentsList.Append(target.wrapped); toolsList.Append(tool.wrapped);
        builder.SetArguments(argumentsList); builder.SetTools(toolsList);
        builder.SetNonDestructive(true); builder.Build();
        if (builder.HasErrors()) fail('El núcleo CAD no pudo calcular esta operación booleana.');
        const native = builder.Shape();
        try {
          const wrapped = cast(native);
          if (!isShape3D(wrapped)) { release(wrapped); fail('La operación no ha producido un sólido CAD.'); }
          result = wrapped;
        } finally { native.delete(); }
      } finally { builder.delete(); argumentsList.delete(); toolsList.delete(); }
    }
    try {
      if (!checked) valid(result!);
      const before = measureVolume(target), after = measureVolume(result);
      const tolerance = Math.max(1e-8, before * 1e-8);
      if (mode === 'cut' && before - after <= tolerance) fail('El corte no retira material. Comprueba la posición y el tamaño de la herramienta.');
      if (mode === 'add' && after - before <= tolerance) fail('La unión no añade material a la pieza.');
      return result;
    } catch (error) { release(result); throw error; }
  }

  private render(id: string, body: Body): RenderBody {
    const shape = body.shape;
    const mesh = shape.mesh({ tolerance: .05, angularTolerance: .18 });
    if (mesh.triangles.length > 6_000_000) fail('La vista supera el límite de dos millones de triángulos.');
    const edges = shape.meshEdges({ tolerance: .1, angularTolerance: .25 });
    const faces = topology(shape, 'face'), topologyEdges = topology(shape, 'edge');
    try {
      const faceIndices = new Map(faces.map((face, index) => [face.hashCode, index]));
      const edgeIndices = new Map(topologyEdges.map((edge, index) => [edge.hashCode, index]));
      const box = shape.boundingBox;
      let bounds: { min: Vec3; max: Vec3 };
      try { const [min, max] = box.bounds; bounds = { min: [...min] as Vec3, max: [...max] as Vec3 }; }
      finally { box.delete(); }
      return {
        id, name: body.name, imported: body.imported,
        mesh: { vertices: Float32Array.from(mesh.vertices), normals: Float32Array.from(mesh.normals), triangles: Uint32Array.from(mesh.triangles) },
        faceGroups: mesh.faceGroups.map(group => {
          const faceIndex = faceIndices.get(group.faceId);
          if (faceIndex === undefined) fail('El núcleo no pudo asociar una cara de la vista con su topología.');
          return { start: group.start, count: group.count, faceIndex };
        }),
        edgePositions: Float32Array.from(edges.lines),
        edgeGroups: edges.edgeGroups.map(group => {
          const edgeIndex = edgeIndices.get(group.edgeId);
          if (edgeIndex === undefined) fail('El núcleo no pudo asociar una arista de la vista con su topología.');
          return { start: group.start, count: group.count, edgeIndex };
        }),
        volume: measureVolume(shape), area: measureArea(shape), bounds, solids: countSolids(shape),
      };
    } finally { faces.forEach(release); topologyEdges.forEach(release); }
  }

  async export(format: 'step' | 'stl', bodyIds?: string[]): Promise<ExportResult> {
    if (!this.exportable) fail('La exportación está bloqueada hasta que todas las operaciones se calculen sin errores.');
    if (format !== 'step' && format !== 'stl') fail('Formato de exportación no admitido.');
    if (bodyIds !== undefined && (!Array.isArray(bodyIds) || !bodyIds.length)) fail('Selecciona al menos un cuerpo para exportar.');
    const ids = bodyIds ? [...new Set(bodyIds)] : [...this.bodies.keys()];
    const records = ids.map(id => this.bodies.get(id) || fail('Uno de los cuerpos seleccionados ya no existe.'));
    let blob: Blob;
    if (format === 'step') blob = exportSTEP(records.map(record => ({ shape: record.shape, name: record.name })), { unit: 'MM', modelUnit: 'MM' });
    else {
      const compound = makeCompound(records.map(record => record.shape));
      try { blob = compound.blobSTL({ binary: true, tolerance: .025, angularTolerance: .1 }); }
      finally { release(compound); }
    }
    const data = await blob.arrayBuffer();
    if (!data.byteLength) fail('El núcleo CAD ha generado un archivo vacío.');
    return { data, mime: format === 'step' ? 'application/step' : 'model/stl', extension: format === 'step' ? 'step' : 'stl' };
  }
}
