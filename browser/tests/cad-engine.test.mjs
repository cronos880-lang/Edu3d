import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Exercise the same TypeScript engine and installed WASM used by the HTML,
// without a browser, server, network request, or a substitute geometry kernel.
const require = createRequire(import.meta.url);
let CadEngine, importSTEP, measureVolume, getOC;
let temporaryDirectory;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'edu3d-cad-engine-'));
  const modulePath = join(temporaryDirectory, 'engine.mjs');
  await build({
    stdin: {
      contents: `export { CadEngine } from './src/kernel/engine'; export { setOC, getOC, importSTEP, measureVolume } from 'replicad';`,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: modulePath,
    logLevel: 'silent',
  });
  const kernel = await import(pathToFileURL(modulePath).href);
  const createOpenCascade = require('replicad-opencascadejs');
  const oc = await createOpenCascade({
    wasmBinary: await readFile(require.resolve('replicad-opencascadejs/wasm')),
    print() {}, printErr() {},
  });
  kernel.setOC(oc);
  ({ CadEngine, importSTEP, measureVolume, getOC } = kernel);
}, { timeout: 120_000 });

after(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

function document(features = []) {
  return { schema: 'edu3d-cad', version: 2, name: 'Kernel validation', units: 'mm', assets: {}, features };
}

function box(id = 'base', overrides = {}) {
  return { id, name: id, type: 'primitive', kind: 'box', mode: 'new', width: 20, depth: 16, height: 12, radius: 3, center: [0, 0, 0], ...overrides };
}

function sketch(entities, overrides = {}) {
  return { id: 'profile', name: 'Profile', type: 'sketch', plane: 'XY', offset: 0, entities, ...overrides };
}

function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `Expected ${expected}, received ${actual}`);
}

function vectorClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => close(value, expected[i]));
}

function successful(result) {
  assert.equal(result.ok, true, JSON.stringify(result.features));
  assert.ok(result.features.every(feature => feature.status === 'ok' || feature.status === 'suppressed'));
  assert.ok(result.bodies.length > 0, 'Expected actual solid bodies');
  for (const body of result.bodies) {
    assert.ok(body.volume > 0 && body.area > 0 && body.solids > 0);
    assert.ok(body.mesh.vertices instanceof Float32Array);
    assert.ok(body.mesh.triangles instanceof Uint32Array);
    assert.ok(body.mesh.triangles.length > 0 && body.mesh.triangles.length % 3 === 0);
    assert.ok(body.faceGroups.length > 0 && body.edgeGroups.length > 0);
    for (const group of body.faceGroups) assert.ok(Number.isInteger(group.faceIndex) && group.faceIndex >= 0);
    for (const group of body.edgeGroups) assert.ok(Number.isInteger(group.edgeIndex) && group.edgeIndex >= 0);
  }
  return result.bodies[0];
}

async function withEngine(run) {
  const engine = new CadEngine();
  try { return await run(engine); }
  finally { await engine.build(document()); }
}

test('primitive solids expose analytic volumes, placement and selectable topology', async () => withEngine(async engine => {
  const result = await engine.build(document([
    box('box', { width: 20, depth: 16, height: 10, center: [5, -3, 9] }),
    box('cylinder', { kind: 'cylinder', radius: 3, height: 12, center: [40, 0, 0] }),
    box('sphere', { kind: 'sphere', radius: 4, center: [-40, 0, 0] }),
  ]));
  successful(result);
  assert.equal(result.bodies.length, 3);
  close(result.bodies[0].volume, 3200);
  vectorClose(result.bodies[0].bounds.min, [-5, -11, 4]);
  vectorClose(result.bodies[0].bounds.max, [15, 5, 14]);
  close(result.bodies[1].volume, Math.PI * 3 ** 2 * 12);
  close(result.bodies[2].volume, 4 / 3 * Math.PI * 4 ** 3);
  assert.equal(new Set(result.bodies[0].faceGroups.map(group => group.faceIndex)).size, 6);
  assert.equal(new Set(result.bodies[0].edgeGroups.map(group => group.edgeIndex)).size, 12);
}));

test('STEP roundtrip retains the real solid, units and dimensions; STL is binary geometry', async () => withEngine(async engine => {
  successful(await engine.build(document([box('exported', { width: 24, depth: 18, height: 9 })])));
  const exported = await engine.export('step');
  assert.equal(exported.mime, 'application/step');
  assert.equal(exported.extension, 'step');
  const stepText = new TextDecoder().decode(exported.data);
  assert.match(stepText, /^ISO-10303-21;/);
  assert.match(stepText, /MANIFOLD_SOLID_BREP|ADVANCED_BREP_SHAPE_REPRESENTATION/);
  const restored = await importSTEP(new Blob([exported.data]));
  try {
    close(measureVolume(restored), 24 * 18 * 9);
    const analyzer = new (getOC().BRepCheck_Analyzer)(restored.wrapped, true, false, false);
    try { assert.equal(analyzer.IsValid(restored.wrapped), true); } finally { analyzer.delete(); }
    const boundingBox = restored.boundingBox;
    try {
      const [min, max] = boundingBox.bounds;
      vectorClose(max.map((value, i) => value - min[i]), [24, 18, 9]);
    } finally { boundingBox.delete(); }
  } finally { restored.delete(); }
  const stl = await engine.export('stl', ['exported']);
  assert.equal(stl.mime, 'model/stl');
  const view = new DataView(stl.data);
  const triangles = view.getUint32(80, true);
  assert.ok(triangles >= 12);
  assert.equal(stl.data.byteLength, 84 + 50 * triangles);
  await assert.rejects(engine.export('step', ['missing']), /ya no existe/);
  await assert.rejects(engine.export('step', []), /al menos un cuerpo/);
}));

test('sketch extrusion preserves centered rectangles, holes, offset and symmetric distance', async () => withEngine(async engine => {
  const result = await engine.build(document([
    sketch([
      { id: 'outline', type: 'rectangle', x: 0, y: 0, width: 20, height: 16 },
      { id: 'hole', type: 'circle', x: 0, y: 0, radius: 2, cut: true },
    ], { offset: 2 }),
    { id: 'extrusion', name: 'Extrusion', type: 'extrude', sketchId: 'profile', distance: 6, symmetric: true, mode: 'new' },
  ]));
  const body = successful(result);
  close(body.volume, (20 * 16 - Math.PI * 2 ** 2) * 6);
  vectorClose(body.bounds.min, [-10, -8, -1]);
  vectorClose(body.bounds.max, [10, 8, 5]);
  assert.equal(body.solids, 1);
}));

test('revolving a planar profile produces an analytic hollow cylinder and partial turn', async () => withEngine(async engine => {
  const profile = sketch([{ id: 'radial', type: 'rectangle', x: 7, y: 0, width: 4, height: 10 }], { plane: 'XZ' });
  const revolution = { id: 'revolved', name: 'Revolution', type: 'revolve', sketchId: 'profile', axis: 'Z', origin: [0, 0, 0], angle: 360, mode: 'new' };
  const full = successful(await engine.build(document([profile, revolution])));
  close(full.volume, Math.PI * (9 ** 2 - 5 ** 2) * 10);
  vectorClose(full.bounds.min, [-9, -9, -5]);
  vectorClose(full.bounds.max, [9, 9, 5]);
  const half = successful(await engine.build(document([profile, { ...revolution, angle: 180 }])));
  close(half.volume, full.volume / 2);
}));

for (const [operation, expected] of [['add', 12000], ['cut', 4000], ['intersect', 4000]]) {
  test(`boolean ${operation} computes solid material and consumes the tool`, async () => withEngine(async engine => {
    const result = await engine.build(document([
      box('a', { width: 20, depth: 20, height: 20 }),
      box('b', { width: 20, depth: 20, height: 20, center: [10, 0, 0] }),
      { id: 'boolean', name: 'Boolean', type: 'boolean', target: 'a', tool: 'b', operation, keepTool: false },
    ]));
    close(successful(result).volume, expected);
    assert.equal(result.bodies.length, 1);
    assert.equal(result.bodies[0].id, 'a');
  }));
}

for (const type of ['fillet', 'chamfer']) {
  test(`${type} modifies actual edges while retaining the outer dimensions`, async () => withEngine(async engine => {
    const result = await engine.build(document([
      box(),
      { id: 'finish', name: type, type, target: 'base', radius: 1, distance: 1, edges: [0] },
    ]));
    const body = successful(result);
    assert.ok(body.volume < 20 * 16 * 12 && body.volume > 0.9 * 20 * 16 * 12);
    vectorClose(body.bounds.min, [-10, -8, -6]);
    vectorClose(body.bounds.max, [10, 8, 6]);
    assert.ok(body.faceGroups.length > 6);
  }));
}

test('shell removes the top face and retains the expected wall and floor thickness', async () => withEngine(async engine => {
  const result = await engine.build(document([
    box('base', { width: 20, depth: 20, height: 20 }),
    { id: 'shell', name: 'Open box', type: 'shell', target: 'base', thickness: 2 },
  ]));
  const body = successful(result);
  close(body.volume, 20 ** 3 - 16 * 16 * 18);
  assert.equal(body.solids, 1);
  vectorClose(body.bounds.min, [-10, -10, -10]);
  vectorClose(body.bounds.max, [10, 10, 10]);
}));

test('linear and circular patterns create distinct solids without duplicating the full-turn endpoint', async () => withEngine(async engine => {
  const seed = box('seed', { width: 2, depth: 2, height: 2, center: [10, 0, 0] });
  const pattern = { id: 'repeat', name: 'Pattern', type: 'pattern', target: 'seed', kind: 'linear', count: 3, direction: [1, 0, 0], distance: 10, angle: 360, origin: [0, 0, 0] };
  const linear = successful(await engine.build(document([seed, pattern])));
  close(linear.volume, 3 * 8);
  assert.equal(linear.solids, 3);
  vectorClose(linear.bounds.min, [9, -1, -1]);
  vectorClose(linear.bounds.max, [31, 1, 1]);
  const circular = successful(await engine.build(document([seed, { ...pattern, kind: 'circular', count: 4, direction: [0, 0, 1] }])));
  close(circular.volume, 4 * 8);
  assert.equal(circular.solids, 4);
  vectorClose(circular.bounds.min, [-11, -11, -1]);
  vectorClose(circular.bounds.max, [11, 11, 1]);
}));

test('mirror respects a displaced plane and optionally keeps the original solid', async () => withEngine(async engine => {
  const seed = box('seed', { width: 2, depth: 3, height: 4, center: [10, 0, 0] });
  const mirror = { id: 'mirror', name: 'Mirror', type: 'mirror', target: 'seed', plane: 'YZ', offset: 2, keepOriginal: true };
  const both = successful(await engine.build(document([seed, mirror])));
  close(both.volume, 48); assert.equal(both.solids, 2);
  vectorClose(both.bounds.min, [-7, -1.5, -2]);
  vectorClose(both.bounds.max, [11, 1.5, 2]);
  const mirrored = successful(await engine.build(document([seed, { ...mirror, keepOriginal: false }])));
  close(mirrored.volume, 24); assert.equal(mirrored.solids, 1);
  vectorClose(mirrored.bounds.min, [-7, -1.5, -2]);
  vectorClose(mirrored.bounds.max, [-5, 1.5, 2]);
}));

test('uniform scale, rotation and translation change the real volume and bounds', async () => withEngine(async engine => {
  const result = await engine.build(document([
    box('base', { width: 2, depth: 4, height: 6 }),
    { id: 'move', name: 'Move', type: 'transform', target: 'base', scale: [2, 2, 2], rotation: [0, 0, 90], translation: [10, 20, 30] },
  ]));
  const body = successful(result);
  close(body.volume, 2 * 4 * 6 * 2 ** 3);
  vectorClose(body.bounds.min, [6, 18, 24]);
  vectorClose(body.bounds.max, [14, 22, 36]);
}));

test('failed history shows its last valid body, skips following features and blocks stale exports until repaired', async () => withEngine(async engine => {
  const previous = successful(await engine.build(document([box()])));
  const failed = await engine.build(document([box('invalid', { width: -1 }), box('skipped')]));
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.features.map(feature => feature.status), ['error', 'skipped']);
  assert.match(failed.features[0].message, /Anchura/);
  assert.ok(failed.warnings.some(warning => /último resultado válido/.test(warning)));
  close(failed.bodies[0].volume, previous.volume);
  await assert.rejects(engine.export('step'), /bloqueada/);
  await assert.rejects(engine.export('stl'), /bloqueada/);
  successful(await engine.build(document([box('fixed', { width: 8 })])));
  assert.ok((await engine.export('step')).data.byteLength > 0);
}));

test('nonintersecting cuts and invalid selections fail visibly instead of exporting unchanged material', async () => withEngine(async engine => {
  for (const invalid of [
    box('ineffective-cut', { mode: 'cut', target: 'base', center: [100, 0, 0] }),
    { id: 'bad-scale', name: 'Bad scale', type: 'transform', target: 'base', scale: [1, 2, 1], rotation: [0, 0, 0], translation: [0, 0, 0] },
    { id: 'missing-edge', name: 'Missing edge', type: 'fillet', target: 'base', radius: 1, edges: [9999] },
  ]) {
    const failed = await engine.build(document([box(), invalid]));
    assert.equal(failed.ok, false, invalid.id);
    assert.equal(failed.features.at(-1).status, 'error', invalid.id);
    assert.ok(failed.features.at(-1).message, invalid.id);
    close(failed.bodies[0].volume, 20 * 16 * 12);
    await assert.rejects(engine.export('step'), /bloqueada/);
  }
}));

test('suppressing a feature omits its operation while preserving a valid exportable history', async () => withEngine(async engine => {
  const result = await engine.build(document([
    box(),
    { id: 'suppressed', name: 'Suppressed error', type: 'fillet', target: 'missing', radius: -1, suppressed: true },
  ]));
  close(successful(result).volume, 20 * 16 * 12);
  assert.deepEqual(result.features.map(feature => feature.status), ['ok', 'suppressed']);
  assert.ok((await engine.export('step')).data.byteLength > 0);
}));
