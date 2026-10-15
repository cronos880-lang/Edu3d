import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
let kernel, temporary;
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'edu3d-import-kernel-'));
  const file = join(temporary, 'imports.mjs');
  await build({ stdin: { contents: `export {importAsset} from './src/kernel/importers'; export {CadEngine} from './src/kernel/engine'; export {setOC,makeBox,makeCylinder,measureVolume,getOC,exportSTEP,importSTEP} from 'replicad';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent' });
  kernel = await import(pathToFileURL(file).href);
  const oc = await require('replicad-opencascadejs')({ wasmBinary: await readFile(require.resolve('replicad-opencascadejs/wasm')), print() {}, printErr() {} });
  kernel.setOC(oc);
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

let id = 0;
function asset(bytes, overrides = {}) {
  return { id: `import-${++id}`, name: 'piece.stl', format: 'stl', units: 'mm', data: Buffer.from(bytes).toString('base64'), ...overrides };
}
async function stl(binary = true) {
  const shape = kernel.makeBox([0, 0, 0], [20, 16, 10]);
  try { return Buffer.from(await shape.blobSTL({ binary }).arrayBuffer()); }
  finally { shape.delete(); }
}
function close(actual, expected, relative = 1e-6) {
  assert.ok(Math.abs(actual - expected) < Math.max(1, Math.abs(expected)) * relative, `${actual} != ${expected}`);
}

test('binary and ASCII STL become valid B-rep solids with actual boolean geometry', async () => {
  for (const binary of [true, false]) {
    const imported = await kernel.importAsset(asset(await stl(binary)));
    assert.match(imported.warnings.join(' '), /no contiene el historial/);
    close(kernel.measureVolume(imported.shape), 3200);
    const cutter = kernel.makeCylinder(2, 30, [10, 8, -10]);
    const changed = imported.shape.cut(cutter);
    const checker = new (kernel.getOC()).BRepCheck_Analyzer(changed.wrapped, true, false, false);
    try {
      assert.equal(checker.IsValid(), true);
      close(kernel.measureVolume(changed), 3200 - Math.PI * 4 * 10);
      close(kernel.measureVolume(imported.shape), 3200);
    } finally { checker.delete(); changed.delete(); cutter.delete(); }
  }
});

test('STL unit choice changes millimetre dimensions and volume', async () => {
  for (const [units, factor] of [['mm', 1], ['cm', 10], ['in', 25.4]]) {
    const imported = await kernel.importAsset(asset(await stl(), { units }));
    close(kernel.measureVolume(imported.shape), 3200 * factor ** 3);
    const box = imported.shape.boundingBox;
    try { close(box.bounds[1][0] - box.bounds[0][0], 20 * factor); }
    finally { box.delete(); }
  }
});

test('cache retains the original shape after consumers transform their clone', async () => {
  const source = asset(await stl());
  const first = await kernel.importAsset(source);
  const clone = first.shape.clone().scale(2).translate(50, 0, 0);
  try { close(kernel.measureVolume(clone), 3200 * 8); }
  finally { clone.delete(); }
  const second = await kernel.importAsset(source);
  assert.equal(first.shape, second.shape);
  close(kernel.measureVolume(second.shape), 3200);
});

test('imported STL boolean uses native solids, rebuilds an edited radius and exports valid STEP', async () => {
  const source = asset(await stl());
  const engine = new kernel.CadEngine();
  const doc = { schema: 'edu3d-cad', version: 2, name: 'Imported operation', units: 'mm', assets: { [source.id]: source }, features: [
    { id: 'base', name: 'Imported', type: 'import', assetId: source.id },
    { id: 'hole', name: 'New bore', type: 'primitive', kind: 'cylinder', mode: 'cut', target: 'base', width: 1, depth: 1, height: 14, radius: .9, center: [10, 8, 5] },
  ] };
  try {
    for (const radius of [.9, 1]) {
      doc.features[1].radius = radius;
      const result = await engine.build(doc);
      assert.equal(result.ok, true, JSON.stringify(result.features));
      close(result.bodies[0].volume, 3200 - Math.PI * radius ** 2 * 10);
      const step = await engine.export('step');
      const restored = await kernel.importSTEP(new Blob([step.data]));
      const checker = new (kernel.getOC()).BRepCheck_Analyzer(restored.wrapped, true, false, false);
      try {
        assert.equal(checker.IsValid(), true);
        close(kernel.measureVolume(restored), 3200 - Math.PI * radius ** 2 * 10);
      } finally { checker.delete(); restored.delete(); }
    }
  } finally { await engine.build({ ...doc, features: [] }); }
});

test('STEP uses declared file units and retains analytic surfaces', async () => {
  const cylinder = kernel.makeCylinder(4, 15);
  try {
    const bytes = await kernel.exportSTEP([{ shape: cylinder }], { unit: 'MM', modelUnit: 'MM' }).arrayBuffer();
    const imported = await kernel.importAsset(asset(bytes, { format: 'step', units: 'in' }));
    close(kernel.measureVolume(imported.shape), Math.PI * 16 * 15);
    const faces = imported.shape.faces;
    try { assert.ok(faces.some(face => face.geomType === 'CYLINDRE' || face.geomType === 'CYLINDER')); }
    finally { faces.forEach(face => face.delete()); }
    assert.match(imported.warnings.join(' '), /propio archivo/);
  } finally { cylinder.delete(); }
});

test('open, nonmanifold and inconsistently oriented STL are rejected before CAD allocation', async () => {
  const original = await stl();
  const opened = Buffer.from(original.subarray(0, original.length - 50)); opened.writeUInt32LE(11, 80);
  await assert.rejects(kernel.importAsset(asset(opened)), /cerrada y manifold/);
  const duplicate = Buffer.concat([original, original.subarray(84, 134)]); duplicate.writeUInt32LE(13, 80);
  await assert.rejects(kernel.importAsset(asset(duplicate)), /cerrada y manifold/);
  const reversed = Buffer.from(original);
  original.copy(reversed, 108, 120, 132); original.copy(reversed, 120, 108, 120);
  await assert.rejects(kernel.importAsset(asset(reversed)), /orientación/);
});

test('invalid coordinates, size, base64 and oversized triangle counts are explicit errors', async () => {
  const nonfinite = await stl(); nonfinite.writeFloatLE(Infinity, 96);
  await assert.rejects(kernel.importAsset(asset(nonfinite)), /coordenadas inválidas/);
  const oversized = Buffer.alloc(84 + 25001 * 50); oversized.writeUInt32LE(25001, 80);
  await assert.rejects(kernel.importAsset(asset(oversized)), /25.000 triángulos/);
  await assert.rejects(kernel.importAsset(asset(Buffer.from('invalid'))), /STL ASCII/);
  await assert.rejects(kernel.importAsset(asset([], { data: '!invalid?' })), /base64/);
  await assert.rejects(kernel.importAsset(asset(Buffer.alloc(20 * 1024 * 1024 + 1))), /20 MiB/);
});
