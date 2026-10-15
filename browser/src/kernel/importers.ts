import { cast, getOC, importSTEP, isShape3D, iterTopo, makeCompound, measureVolume, type AnyShape, type Shape3D } from 'replicad';
import type { Asset, CadProgress } from '../types';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TRIANGLES = 25000;
const cache = new Map<string, { data: string; units: string; format: string; shape: Shape3D; warnings: string[] }>();

function dispose(object: { delete(): void } | null | undefined): void { if (object) { try { object.delete(); } catch { /* no-op */ } } }
function validate(shape: AnyShape): asserts shape is Shape3D {
  if (shape.isNull || !isShape3D(shape)) throw new Error('El archivo no contiene sólidos CAD tridimensionales.');
  const solids = shape.solids;
  try { if (!solids.length || solids.length > 64) throw new Error('Se requieren entre 1 y 64 sólidos cerrados.'); }
  finally { solids.forEach(dispose); }
  const checker = new (getOC()).BRepCheck_Analyzer(shape.wrapped, true, false, false);
  try { if (!checker.IsValid()) throw new Error('El archivo no produce un sólido CAD válido. Repara la malla antes de importarla.'); }
  finally { checker.delete(); }
  if (!(measureVolume(shape) > 1e-10)) throw new Error('El archivo no encierra un volumen positivo.');
}

function decode(asset: Asset): Uint8Array {
  if (typeof asset.data !== 'string' || asset.data.length > Math.ceil(MAX_BYTES * 4 / 3) + 1024)
    throw new Error('El archivo importado supera el límite de 20 MiB.');
  const encoded = asset.data.startsWith('data:') ? asset.data.slice(asset.data.indexOf(',') + 1) : asset.data;
  let binary: string;
  try { binary = atob(encoded); } catch { throw new Error('Los datos del archivo no son una codificación base64 válida.'); }
  if (!binary.length || binary.length > MAX_BYTES) throw new Error('El archivo debe contener entre 1 byte y 20 MiB.');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Check STL coordinates and welded edge incidence before allocating CAD faces. */
function inspectSTL(bytes: Uint8Array, scale: number): { span: number; volume: number; triangles: number } {
  let coordinates: number[];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.length >= 84 ? view.getUint32(80, true) : 0;
  if (bytes.length >= 84 && 84 + count * 50 === bytes.length) {
    if (!count || count > MAX_TRIANGLES) throw new Error('El STL debe contener entre 1 y 25.000 triángulos.');
    coordinates = new Array(count * 9);
    for (let i = 0; i < count; i++) for (let j = 0; j < 9; j++) coordinates[i * 9 + j] = view.getFloat32(84 + i * 50 + 12 + j * 4, true);
  } else {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('STL binario incompleto o formato no reconocido.'); }
    const vertex = /\bvertex\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/gi;
    coordinates = [];
    for (const match of text.matchAll(vertex)) coordinates.push(Number(match[1]), Number(match[2]), Number(match[3]));
    const triangles = coordinates.length / 9;
    if (!Number.isInteger(triangles) || !triangles || triangles > MAX_TRIANGLES
      || (text.match(/\bendfacet\b/gi) || []).length !== triangles
      || (text.match(/\bvertex\b/gi) || []).length !== triangles * 3)
      throw new Error('El STL ASCII está incompleto o supera 25.000 triángulos.');
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  coordinates.forEach((value, i) => {
    if (!Number.isFinite(value) || Math.abs(value * scale) > 1e6) throw new Error('El STL contiene coordenadas inválidas o superiores a 1.000.000 mm.');
    min[i % 3] = Math.min(min[i % 3], value); max[i % 3] = Math.max(max[i % 3], value);
  });
  const span = Math.max(...max.map((value, i) => value - min[i]));
  if (span * scale < .001 || span * scale > 100000) throw new Error('El tamaño del STL no es válido; revisa sus unidades.');
  const tolerance = Math.max(1e-8, span * 1e-8);
  const vertices = new Map<string, number>();
  const edges = new Map<string, { count: number; balance: number }>();
  const origin = coordinates.slice(0, 3);
  let volume = 0;
  for (let i = 0; i < coordinates.length; i += 9) {
    const triangle: number[] = [];
    for (let j = 0; j < 3; j++) {
      const key = coordinates.slice(i + j * 3, i + j * 3 + 3).map(value => Math.round(value / tolerance)).join(',');
      let id = vertices.get(key);
      if (id === undefined) { id = vertices.size; vertices.set(key, id); }
      triangle.push(id);
    }
    if (new Set(triangle).size !== 3) throw new Error('La malla contiene triángulos degenerados.');
    const a = coordinates.slice(i, i + 3).map((v, k) => v - origin[k]);
    const b = coordinates.slice(i + 3, i + 6).map((v, k) => v - origin[k]);
    const c = coordinates.slice(i + 6, i + 9).map((v, k) => v - origin[k]);
    const ab = b.map((v, k) => v - a[k]), ac = c.map((v, k) => v - a[k]);
    if (Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) < tolerance * tolerance)
      throw new Error('La malla contiene triángulos de superficie nula.');
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    for (let j = 0; j < 3; j++) {
      const aId = triangle[j], bId = triangle[(j + 1) % 3];
      const key = `${Math.min(aId, bId)},${Math.max(aId, bId)}`;
      const edge = edges.get(key) || { count: 0, balance: 0 };
      edge.count++; edge.balance += aId < bId ? 1 : -1;
      edges.set(key, edge);
    }
  }
  for (const edge of edges.values()) {
    if (edge.count !== 2) throw new Error('La malla no es cerrada y manifold. Repara agujeros y aristas compartidas antes de importarla.');
    if (edge.balance !== 0) throw new Error('La orientación de las caras del STL es inconsistente. Repara sus normales.');
  }
  if (Math.abs(volume) * scale ** 3 <= 1e-10) throw new Error('La malla no encierra un volumen medible.');
  return { span, volume: Math.abs(volume), triangles: coordinates.length / 9 };
}

function stlSolid(bytes: Uint8Array, span: number, onProgress?: (p: CadProgress) => void): Shape3D {
  const oc = getOC();
  const path = `/edu3d-${Date.now()}-${Math.random().toString(36).slice(2)}.stl`;
  const reader = new oc.StlAPI_Reader();
  const source = new oc.TopoDS_Shell();
  const tolerance = Math.max(1e-7, span * 1e-8);
  const sewing = new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false);
  const resources: { delete(): void }[] = [reader, source, sewing];
  const solids: Shape3D[] = [];
  try {
    oc.FS.writeFile(path, bytes);
    if (!reader.Read(source, path)) throw new Error('OpenCascade no puede leer este STL.');
    onProgress?.({ stage: 'Cosiendo caras del STL en un sólido CAD', progress: .3 });
    sewing.Add(source); sewing.Perform();
    if (sewing.NbFreeEdges() || sewing.NbMultipleEdges()) throw new Error('El cosido CAD dejó aristas abiertas o no manifold. Repara el STL.');
    const sewed = sewing.SewedShape(); resources.push(sewed);
    onProgress?.({ stage: 'Construyendo y validando el sólido importado', progress: .65 });
    for (const shell of iterTopo(sewed, 'shell')) {
      resources.push(shell);
      if (!oc.BRep_Tool.IsClosed(shell)) throw new Error('Una envolvente del STL no está cerrada.');
      const maker = new oc.BRepBuilderAPI_MakeSolid(shell); resources.push(maker);
      const native = maker.Solid(); resources.push(native);
      if (!oc.BRepLib.OrientClosedSolid(native)) throw new Error('No se pudo orientar el volumen cerrado del STL.');
      const solid = cast(oc.TopoDS.Solid(native)).asShape3D();
      solids.push(solid);
    }
    if (!solids.length || solids.length > 64) throw new Error('El STL debe formar entre 1 y 64 cuerpos cerrados.');
    let result: Shape3D;
    if (solids.length === 1) result = solids.pop()!;
    else result = makeCompound(solids).asShape3D();
    // Keep each source triangle as a planar face. Unifying nearly coplanar
    // STL facets can create giant faces with thousands of tiny boundaries;
    // subsequent browser tessellation may become prohibitively expensive.
    return result;
  } finally {
    solids.forEach(dispose);
    resources.reverse().forEach(dispose);
    try { oc.FS.unlink(path); } catch { /* File may not have been created. */ }
  }
}

/** Cached shapes belong to the importer. Callers must clone before mutation. */
export async function importAsset(asset: Asset, onProgress?: (p: CadProgress) => void): Promise<{ shape: Shape3D; warnings: string[] }> {
  if (!asset || typeof asset.id !== 'string' || !['stl', 'step'].includes(asset.format)) throw new Error('Archivo importado no válido.');
  if (!['mm', 'cm', 'in'].includes(asset.units)) throw new Error('Unidad de importación no válida.');
  const previous = cache.get(asset.id);
  if (previous && previous.data === asset.data && previous.units === asset.units && previous.format === asset.format)
    return { shape: previous.shape, warnings: [...previous.warnings] };
  const bytes = decode(asset), scale = asset.units === 'cm' ? 10 : asset.units === 'in' ? 25.4 : 1;
  const warnings: string[] = [];
  onProgress?.({ stage: `Leyendo ${asset.name}`, progress: .05 });
  let shape: AnyShape;
  if (asset.format === 'stl') {
    const inspection = inspectSTL(bytes, scale);
    shape = stlSolid(bytes, inspection.span, onProgress);
    const actual = measureVolume(shape), expected = inspection.volume;
    if (Math.abs(actual - expected) > Math.max(1e-6, expected * 1e-4)) {
      dispose(shape); throw new Error('El volumen cosido no coincide con la malla: contiene envolventes ambiguas o cuerpos superpuestos.');
    }
    if (scale !== 1) shape = shape.scale(scale);
    warnings.push('STL importado como sólido de caras planas. Puedes crear operaciones CAD nuevas, pero el archivo no contiene el historial ni las superficies originales.');
  } else {
    // STEP declares its own length units; OpenCascade converts them to mm.
    shape = await importSTEP(new Blob([bytes.slice().buffer]));
    warnings.push('Las unidades del STEP se han leído del propio archivo.');
  }
  try { validate(shape); }
  catch (error) { dispose(shape); throw error; }
  if (previous) dispose(previous.shape);
  cache.delete(asset.id);
  cache.set(asset.id, { shape, data: asset.data, units: asset.units, format: asset.format, warnings });
  while (cache.size > 8) { const key = cache.keys().next().value!; dispose(cache.get(key)!.shape); cache.delete(key); }
  onProgress?.({ stage: 'Sólido importado listo', progress: 1 });
  return { shape, warnings: [...warnings] };
}
