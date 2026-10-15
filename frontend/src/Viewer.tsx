import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MeshData } from './types';

export type ViewName = 'iso' | 'front' | 'top' | 'right';
export type ViewerHandle = { fit: () => void; setView: (name: ViewName) => void };
type Props = { original: MeshData | null; model: MeshData | null; showOriginal: boolean; showModel: boolean; wireframe: boolean; onSelect: (part: 'mesh' | 'solid') => void; onPick?: (point: number[]) => void };
type ViewContext = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  group: THREE.Group;
  grid: THREE.GridHelper;
  fit: () => void;
  view: (name: ViewName) => void;
};

function geometryFor(data: MeshData) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.vertices.flat(), 3));
  geometry.setIndex(data.faces.flat());
  geometry.computeVertexNormals();
  return geometry;
}

const Viewer = forwardRef<ViewerHandle, Props>(function Viewer(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const context = useRef<ViewContext | null>(null);
  const onSelect = useRef(props.onSelect);
  const onPick = useRef(props.onPick);
  const [failure, setFailure] = useState(false);
  onSelect.current = props.onSelect;
  onPick.current = props.onPick;
  useImperativeHandle(ref, () => ({ fit: () => context.current?.fit(), setView: name => context.current?.view(name) }), []);

  useEffect(() => {
    if (!container.current) return;
    const host = container.current;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setFailure(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xeaf0f3, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', 'Visor 3D. Arrastra para girar, usa la rueda para acercar y botón derecho para desplazar.');
    renderer.domElement.setAttribute('role', 'img');
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000000);
    camera.up.set(0, 0, 1);
    camera.position.set(95, -120, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.screenSpacePanning = true;
    controls.target.set(0, 0, 8);
    const ambient = new THREE.HemisphereLight(0xffffff, 0x738593, 2.5);
    const key = new THREE.DirectionalLight(0xffffff, 3.5);
    key.position.set(100, -70, 150);
    const fill = new THREE.DirectionalLight(0xddefff, 1.2);
    fill.position.set(-80, 70, 40);
    scene.add(ambient, key, fill);
    const group = new THREE.Group();
    scene.add(group);
    const grid = new THREE.GridHelper(300, 30, 0xb8c8ce, 0xd5e0e5);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.08;
    scene.add(grid);
    const axes = new THREE.AxesHelper(28);
    axes.position.z = 0.02;
    scene.add(axes);

    const fit = () => {
      const bounds = new THREE.Box3().setFromObject(group);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      if (bounds.isEmpty()) { center.set(0, 0, 8); size.set(70, 70, 30); }
      else { bounds.getCenter(center); bounds.getSize(size); }
      const radius = Math.max(size.length() / 2, 1);
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const distance = radius / Math.sin(fov / 2) * Math.max(1, 1 / camera.aspect) * 1.15;
      let direction = camera.position.clone().sub(controls.target).normalize();
      if (direction.length() < 0.1) direction = new THREE.Vector3(1, -1.5, 1);
      camera.position.copy(center.clone().add(direction.multiplyScalar(distance)));
      camera.near = Math.max(radius / 1000, 0.001);
      camera.far = Math.max(distance * 30, 1000);
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.minDistance = radius * 0.03;
      controls.maxDistance = distance * 15;
      const span = Math.pow(10, Math.ceil(Math.log10(Math.max(size.x, size.y, size.z, 10)))) * 3;
      grid.scale.setScalar(span / 300);
      grid.position.x = center.x;
      grid.position.y = center.y;
      grid.position.z = bounds.isEmpty() ? -0.08 : bounds.min.z - radius * 0.003;
      controls.update();
    };
    const view = (name: ViewName) => {
      const directions: Record<ViewName, THREE.Vector3> = {
        iso: new THREE.Vector3(1.1, -1.6, 1.15), front: new THREE.Vector3(0, -1, 0.001),
        top: new THREE.Vector3(0, -0.001, 1), right: new THREE.Vector3(1, 0, 0.001),
      };
      const distance = camera.position.distanceTo(controls.target);
      camera.position.copy(controls.target.clone().add(directions[name].normalize().multiplyScalar(distance)));
      controls.update();
    };
    context.current = { scene, camera, renderer, controls, group, grid, fit, view };
    const resize = () => {
      const width = host.clientWidth, height = host.clientHeight;
      renderer.setSize(width, height);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    let frame = 0;
    const animate = () => { frame = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); };
    animate();
    const pointer = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    let pointerStart = { x: 0, y: 0 };
    const down = (event: PointerEvent) => { pointerStart = { x: event.clientX, y: event.clientY }; };
    const pick = (event: PointerEvent) => {
      if (event.button !== 0 || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(group.children).find(item => item.object.visible);
      if (hit) { onSelect.current(hit.object.name === 'solid' ? 'solid' : 'mesh'); onPick.current?.(hit.point.toArray()); }
    };
    renderer.domElement.addEventListener('pointerdown', down);
    renderer.domElement.addEventListener('pointerup', pick);
    fit();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', down);
      renderer.domElement.removeEventListener('pointerup', pick);
      scene.traverse(obj => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose();
        if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose());
        else mesh.material?.dispose();
      });
      renderer.dispose(); host.removeChild(renderer.domElement); context.current = null;
    };
  }, []);

  useEffect(() => {
    const ctx = context.current;
    if (!ctx) return;
    while (ctx.group.children.length) {
      const object = ctx.group.children[0] as THREE.Mesh;
      object.geometry.dispose(); (object.material as THREE.Material).dispose(); ctx.group.remove(object);
    }
    if (props.original) {
      const mesh = new THREE.Mesh(geometryFor(props.original), new THREE.MeshStandardMaterial({
        color: 0x7d94ac, roughness: 0.68, metalness: 0.08, transparent: true,
        opacity: props.showModel && props.model ? 0.28 : 0.92,
        depthWrite: !(props.showModel && props.model), side: THREE.DoubleSide, wireframe: props.wireframe,
      }));
      mesh.name = 'mesh'; mesh.visible = props.showOriginal; ctx.group.add(mesh);
    }
    if (props.model) {
      const mesh = new THREE.Mesh(geometryFor(props.model), new THREE.MeshStandardMaterial({
        color: 0x43a99b, roughness: 0.48, metalness: 0.15, side: THREE.DoubleSide, wireframe: props.wireframe,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }));
      mesh.name = 'solid'; mesh.visible = props.showModel; ctx.group.add(mesh);
    }
  }, [props.original, props.model, props.showOriginal, props.showModel, props.wireframe]);

  useEffect(() => { context.current?.fit(); }, [props.original]);
  return <div className="viewer" ref={container}>{failure && <div className="webgl-error">El visor necesita WebGL. Activa la aceleración gráfica del navegador para ver la pieza. Puedes seguir usando los parámetros y las exportaciones.</div>}</div>;
});
export default Viewer;
