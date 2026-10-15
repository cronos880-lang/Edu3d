import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { RenderBody, Selection, SketchFeature, Vec3 } from './types';

export type ViewportProps = {
  bodies: RenderBody[];
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  sketch?: SketchFeature | null;
  view?: string;
  wireframe?: boolean;
  showGrid?: boolean;
  fitKey?: number;
  measureMode?: boolean;
  onMeasure?: (points: Vec3[], distance: number) => void;
  selectionMode?: 'body' | 'face' | 'edge';
};

type BodyObjects = { data: RenderBody; mesh: THREE.Mesh; edges: THREE.LineSegments };
type SceneContext = {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  bodies: THREE.Group;
  sketches: THREE.Group;
  highlight: THREE.Group;
  measures: THREE.Group;
  grid: THREE.GridHelper;
  objects: Map<string, BodyObjects>;
  fit: () => void;
  setView: (name: string) => void;
  invalidate: () => void;
  hasFit: boolean;
  span: number;
};

const palette = [0x53ac9f, 0x749fc1, 0xc0a076, 0xa08ac0, 0x9fb86f, 0xca8f99];
const vec = (point: THREE.Vector3): Vec3 => [point.x, point.y, point.z];

function clear(group: THREE.Group) {
  for (const child of [...group.children]) {
    child.traverse(object => {
      const item = object as THREE.Mesh;
      item.geometry?.dispose();
      if (Array.isArray(item.material)) item.material.forEach(material => material.dispose());
      else item.material?.dispose();
    });
    group.remove(child);
  }
}

function drawMeasurements(context: SceneContext, points: Vec3[]) {
  clear(context.measures);
  for (const point of points) {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(context.span / 180, .02), 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xeb9726, depthTest: false }),
    );
    marker.position.fromArray(point);
    marker.renderOrder = 8;
    context.measures.add(marker);
  }
  if (points.length === 2) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points.map(point => new THREE.Vector3(...point)));
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xe29120, depthTest: false }));
    line.renderOrder = 8;
    context.measures.add(line);
  }
  context.invalidate();
}

function sketchPoint(x: number, y: number, sketch: SketchFeature): THREE.Vector3 {
  if (sketch.plane === 'XZ') return new THREE.Vector3(x, -sketch.offset, y);
  if (sketch.plane === 'YZ') return new THREE.Vector3(sketch.offset, x, y);
  return new THREE.Vector3(x, y, sketch.offset);
}

export default function Viewport(props: ViewportProps) {
  const host = useRef<HTMLDivElement>(null);
  const context = useRef<SceneContext | null>(null);
  const latest = useRef(props);
  const measurements = useRef<Vec3[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  latest.current = props;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    } catch {
      setFailure('El visor necesita WebGL. Activa la aceleración gráfica del navegador para ver la geometría.');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0xeaf0f3, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Visor CAD 3D. Arrastra para girar; rueda para acercar; botón derecho para desplazar. Haz clic en caras o aristas para seleccionarlas.');
    element.appendChild(canvas);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-70, 70, 50, -50, .01, 100000);
    camera.up.set(0, 0, 1);
    camera.position.set(90, -125, 95);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = .12;
    controls.screenSpacePanning = true;
    controls.minZoom = .005;
    controls.maxZoom = 10000;
    const hemi = new THREE.HemisphereLight(0xffffff, 0x7e919a, 2.25);
    const key = new THREE.DirectionalLight(0xffffff, 3.1);
    key.position.set(80, -90, 150);
    const fill = new THREE.DirectionalLight(0xdbeeff, 1.0);
    fill.position.set(-90, 65, 45);
    scene.add(hemi, key, fill);
    const bodies = new THREE.Group(), sketches = new THREE.Group(), highlight = new THREE.Group(), measures = new THREE.Group();
    scene.add(bodies, sketches, highlight, measures);
    const grid = new THREE.GridHelper(200, 20, 0xb6c9d0, 0xd4e0e6);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -.025;
    scene.add(grid);
    const axes = new THREE.AxesHelper(15);
    axes.position.z = .01;
    scene.add(axes);
    const objects = new Map<string, BodyObjects>();
    let width = 1, height = 1;
    let needsRender = true;
    const invalidate = () => { needsRender = true; };
    controls.addEventListener('change', invalidate);
    const ctx: SceneContext = {
      scene, camera, renderer, controls, bodies, sketches, highlight, measures, grid, objects,
      hasFit: false, span: 50, invalidate,
      fit: () => {
        const bounds = new THREE.Box3().setFromObject(bodies);
        if (sketches.children.length) bounds.union(new THREE.Box3().setFromObject(sketches));
        const center = new THREE.Vector3(), size = new THREE.Vector3();
        if (bounds.isEmpty()) { center.set(0, 0, 0); size.set(50, 50, 25); }
        else { bounds.getCenter(center); bounds.getSize(size); }
        ctx.span = Math.max(size.x, size.y, size.z, 1);
        const radius = Math.max(size.length() / 2, 1);
        let direction = camera.position.clone().sub(controls.target).normalize();
        if (!Number.isFinite(direction.x) || direction.lengthSq() < .1) direction.set(1.1, -1.5, 1.1).normalize();
        controls.target.copy(center);
        camera.position.copy(center.clone().addScaledVector(direction, Math.max(radius * 4, 100)));
        camera.near = .001;
        camera.far = Math.max(radius * 30, 10000);
        camera.zoom = 1;
        camera.updateMatrixWorld();
        camera.lookAt(center);
        camera.updateMatrixWorld();
        let projectedX = 0, projectedY = 0;
        if (!bounds.isEmpty()) {
          for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
            const point = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
            projectedX = Math.max(projectedX, Math.abs(point.x));
            projectedY = Math.max(projectedY, Math.abs(point.y));
          }
        } else { projectedX = 35; projectedY = 30; }
        const aspect = width / Math.max(height, 1);
        const halfHeight = Math.max(projectedY, projectedX / aspect, 1) * 1.3;
        camera.top = halfHeight; camera.bottom = -halfHeight;
        camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect;
        camera.updateProjectionMatrix();
        const gridSpan = Math.pow(10, Math.floor(Math.log10(ctx.span))) * 20;
        grid.scale.setScalar(gridSpan / 200);
        grid.position.z = Math.min(bounds.isEmpty() ? 0 : bounds.min.z, 0) - radius * .0005;
        axes.scale.setScalar(Math.max(ctx.span / 80, .1));
        controls.update();
        invalidate();
      },
      setView: name => {
        const directions: Record<string, THREE.Vector3> = {
          iso: new THREE.Vector3(1.1, -1.55, 1.15), front: new THREE.Vector3(0, -1, .00001),
          top: new THREE.Vector3(0, -.00001, 1), right: new THREE.Vector3(1, 0, .00001),
        };
        const direction = directions[name] || directions.iso;
        camera.position.copy(controls.target.clone().addScaledVector(direction.clone().normalize(), Math.max(camera.position.distanceTo(controls.target), 100)));
        controls.update();
        ctx.fit();
      },
    };
    context.current = ctx;
    const resize = () => {
      width = Math.max(element.clientWidth, 1); height = Math.max(element.clientHeight, 1);
      renderer.setSize(width, height, false);
      const halfHeight = camera.top;
      camera.left = -halfHeight * width / height; camera.right = halfHeight * width / height;
      camera.updateProjectionMatrix();
      invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    ctx.setView(latest.current.view || 'iso');
    let frame = 0;
    const render = () => {
      frame = requestAnimationFrame(render);
      const moving = controls.update();
      if (needsRender || moving) { renderer.render(scene, camera); needsRender = false; }
    };
    render();
    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
    let down = { x: 0, y: 0 };
    const pointerDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
    const pointerUp = (event: PointerEvent) => {
      if (event.button !== 0 || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
      element.focus({ preventScroll: true });
      const rect = canvas.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const worldPerPixel = (camera.top - camera.bottom) / camera.zoom / Math.max(rect.height, 1);
      raycaster.params.Line = { threshold: worldPerPixel * 5 };
      const all = [...objects.values()];
      const face = raycaster.intersectObjects(all.map(item => item.mesh), false)[0];
      const edge = raycaster.intersectObjects(all.map(item => item.edges), false)[0];
      const mode = latest.current.selectionMode;
      const chooseEdge = !latest.current.measureMode && mode !== 'face' && mode !== 'body' && edge && (!face || edge.distance <= face.distance + worldPerPixel * 8);
      if (mode === 'edge' && !latest.current.measureMode && !chooseEdge) { latest.current.onSelect(null); return; }
      const hit = chooseEdge ? edge : face;
      if (!hit) { latest.current.onSelect(null); return; }
      const bodyId = hit.object.userData.bodyId as string;
      const data = objects.get(bodyId)?.data;
      if (!data) return;
      const point = vec(hit.point);
      let selection: Selection = { bodyId, kind: 'body', point };
      if (chooseEdge) {
        const index = hit.index ?? 0;
        const group = data.edgeGroups.find(group => index >= group.start && index < group.start + group.count);
        if (group) selection = { bodyId, kind: 'edge', index: group.edgeIndex, point };
      } else if (mode !== 'body') {
        const index = (hit.faceIndex ?? 0) * 3;
        const group = data.faceGroups.find(group => index >= group.start && index < group.start + group.count);
        if (group) selection = { bodyId, kind: 'face', index: group.faceIndex, point };
      }
      latest.current.onSelect(selection);
      if (latest.current.measureMode) {
        measurements.current = measurements.current.length >= 2 ? [point] : [...measurements.current, point];
        drawMeasurements(ctx, measurements.current);
        const distance = measurements.current.length === 2 ? new THREE.Vector3(...measurements.current[0]).distanceTo(new THREE.Vector3(...measurements.current[1])) : 0;
        latest.current.onMeasure?.([...measurements.current], distance);
      }
    };
    const keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { latest.current.onSelect(null); measurements.current = []; drawMeasurements(ctx, []); latest.current.onMeasure?.([], 0); } };
    const lost = (event: Event) => { event.preventDefault(); setFailure('El navegador ha perdido el contexto gráfico. Espera a que se restablezca o vuelve a abrir el archivo.'); };
    const restored = () => { setFailure(null); invalidate(); };
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    element.addEventListener('keydown', keyDown);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.removeEventListener('change', invalidate); controls.dispose();
      canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('webglcontextrestored', restored);
      element.removeEventListener('keydown', keyDown);
      clear(bodies); clear(sketches); clear(highlight); clear(measures);
      grid.geometry.dispose(); (grid.material as THREE.Material).dispose();
      axes.geometry.dispose(); (axes.material as THREE.Material).dispose();
      renderer.dispose(); canvas.remove(); context.current = null;
    };
  }, []);

  useEffect(() => {
    const ctx = context.current;
    if (!ctx) return;
    const hasNewBody = props.bodies.some(body => !ctx.objects.has(body.id));
    clear(ctx.bodies); ctx.objects.clear();
    props.bodies.forEach((body, index) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(body.mesh.vertices, 3));
      geometry.setIndex(new THREE.BufferAttribute(body.mesh.triangles, 1));
      if (body.mesh.normals.length === body.mesh.vertices.length) geometry.setAttribute('normal', new THREE.BufferAttribute(body.mesh.normals, 3));
      else geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: palette[index % palette.length], roughness: .57, metalness: .12, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      mesh.userData.bodyId = body.id;
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute('position', new THREE.BufferAttribute(body.edgePositions, 3));
      const edges = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: 0x365c65, transparent: true, opacity: .58 }));
      edges.userData.bodyId = body.id;
      ctx.bodies.add(mesh, edges); ctx.objects.set(body.id, { data: body, mesh, edges });
    });
    if (!props.bodies.length) ctx.hasFit = false;
    if (props.bodies.length && (!ctx.hasFit || hasNewBody)) { ctx.fit(); ctx.hasFit = true; }
    ctx.invalidate();
  }, [props.bodies]);

  useEffect(() => {
    const ctx = context.current;
    if (!ctx) return;
    clear(ctx.sketches);
    ctx.invalidate();
    if (!props.sketch) return;
    const sketch = props.sketch;
    for (const entity of sketch.entities) {
      let points: THREE.Vector3[];
      if (entity.type === 'rectangle') points = [[entity.x, entity.y], [entity.x + entity.width, entity.y], [entity.x + entity.width, entity.y + entity.height], [entity.x, entity.y + entity.height]].map(([x, y]) => sketchPoint(x, y, sketch));
      else if (entity.type === 'circle') points = Array.from({ length: 96 }, (_, index) => { const angle = index / 96 * Math.PI * 2; return sketchPoint(entity.x + Math.cos(angle) * entity.radius, entity.y + Math.sin(angle) * entity.radius, sketch); });
      else points = entity.points.map(([x, y]) => sketchPoint(x, y, sketch));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: entity.cut ? 0xda823a : 0x247be0, depthTest: false }));
      line.renderOrder = 5; ctx.sketches.add(line);
    }
    if (!ctx.bodies.children.length) ctx.fit();
  }, [props.sketch]);

  useEffect(() => {
    const ctx = context.current;
    if (!ctx) return;
    for (const item of ctx.objects.values()) {
      (item.mesh.material as THREE.MeshStandardMaterial).wireframe = !!props.wireframe;
      (item.edges.material as THREE.LineBasicMaterial).opacity = props.wireframe ? .9 : .58;
    }
    ctx.invalidate();
  }, [props.wireframe, props.bodies]);

  useEffect(() => {
    const ctx = context.current;
    if (!ctx) return;
    clear(ctx.highlight);
    ctx.invalidate();
    for (const item of ctx.objects.values()) (item.mesh.material as THREE.MeshStandardMaterial).emissive.setHex(props.selection?.bodyId === item.data.id && props.selection.kind === 'body' ? 0x123b40 : 0x000000);
    const selected = props.selection;
    if (!selected) return;
    const item = ctx.objects.get(selected.bodyId);
    if (!item) return;
    if (selected.kind === 'face') {
      const groups = item.data.faceGroups.filter(group => group.faceIndex === selected.index);
      const indices = new Uint32Array(groups.reduce((sum, group) => sum + group.count, 0));
      let offset = 0;
      for (const group of groups) { indices.set(item.data.mesh.triangles.subarray(group.start, group.start + group.count), offset); offset += group.count; }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(item.data.mesh.vertices, 3));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      const overlay = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x2d98ee, transparent: true, opacity: .48, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      overlay.renderOrder = 3; ctx.highlight.add(overlay);
    } else if (selected.kind === 'edge') {
      for (const group of item.data.edgeGroups.filter(group => group.edgeIndex === selected.index)) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(item.data.edgePositions.subarray(group.start * 3, (group.start + group.count) * 3), 3));
        const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xff9e27, depthTest: false }));
        line.renderOrder = 4; ctx.highlight.add(line);
      }
    }
  }, [props.selection, props.bodies]);

  useEffect(() => { if (context.current) { context.current.grid.visible = props.showGrid !== false; context.current.invalidate(); } }, [props.showGrid]);
  useEffect(() => { context.current?.setView(props.view || 'iso'); }, [props.view]);
  useEffect(() => { context.current?.fit(); }, [props.fitKey]);
  useEffect(() => { measurements.current = []; if (context.current) drawMeasurements(context.current, []); }, [props.measureMode]);

  return <div className="cad-viewport" ref={host} tabIndex={0} aria-label="Área de trabajo CAD" style={{ position: 'absolute', inset: 0, outline: 'none', cursor: props.measureMode ? 'crosshair' : 'default' }}>
    {failure && <div role="alert" className="webgl-error" style={{ position: 'absolute', inset: '35% 12% auto', padding: 24, background: '#fff', borderRadius: 10, zIndex: 10, color: '#8b431e' }}>{failure}</div>}
  </div>;
}
