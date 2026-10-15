import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle, ArrowDownToLine, ArrowRight, Axis3d, Box, Check,
  CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Circle, Download,
  Eye, EyeOff, FileBox, FileJson, FileUp, FolderOpen, Grid2X2, Layers,
  LoaderCircle, Maximize, MoreHorizontal, MousePointer2, Redo2, Rotate3d,
  Plus, Save, ScanLine, Scissors, Settings2, ShieldCheck, Undo2, Upload, X,
} from 'lucide-react';
import Viewer, { type ViewerHandle, type ViewName } from './Viewer';
import OperationEditor, { operationName, type OperationDraft } from './OperationEditor';
import type { AnalyzeResult, MeshData, ModelPreview, ModelSpec, Operation, SavedProject, ShapeKind, Units } from './types';

const MAX_FILE = 20 * 1024 * 1024;
const MAX_PROJECT = 80 * 1024 * 1024;
const shapeNames: Record<ShapeKind, string> = { box: 'Bloque', cylinder: 'Cilindro', tube: 'Tubo', plate: 'Placa perforada', mesh: 'Sólido de referencia' };
const shapeLabels: Record<ShapeKind, string> = { box: 'Bloque rectangular', cylinder: 'Cilindro', tube: 'Tubo cilíndrico', plate: 'Placa con agujero', mesh: 'Dimensiones globales' };
const parameterLabels: Record<string, string> = { width: 'Ancho', depth: 'Fondo', height: 'Altura', diameter: 'Diámetro exterior', inner_diameter: 'Diámetro interior', hole_diameter: 'Diámetro del agujero', hole_x: 'Posición del agujero · X', hole_y: 'Posición del agujero · Y' };
const parameterLetters: Record<string, string> = { width: 'W', depth: 'D', height: 'H', diameter: 'Ø', inner_diameter: 'ø', hole_diameter: 'ø', hole_x: 'X', hole_y: 'Y' };
const n = (value: number, digits = 2) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: digits }).format(value);
const toDraft = (spec: ModelSpec) => Object.fromEntries(Object.entries(spec.parameters).map(([key, value]) => [key, String(Number(value.toFixed(4)))]));
const operationToDraft = (operation: Operation, index: number | null): OperationDraft => ({ ...operation, index, parameters: Object.fromEntries(Object.entries(operation.parameters).map(([key, value]) => [key, String(Number(value.toFixed(4)))])) });
const baseName = (name: string) => name.replace(/\.(stl|edu3d\.json)$/i, '');

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = `No se pudo completar la operación (${response.status}).`;
    try {
      const data = await response.json();
      if (typeof data.detail === 'string') message = data.detail;
      else if (typeof data.message === 'string') message = data.message;
    } catch { /* The response can be a proxy error. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function buildModel(spec: ModelSpec) {
  return request<ModelPreview>('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function validMesh(value: unknown): value is MeshData {
  if (!value || typeof value !== 'object') return false;
  const mesh = value as MeshData;
  return Array.isArray(mesh.vertices) && mesh.vertices.length > 0 && mesh.vertices.length <= 750000
    && mesh.vertices.every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))
    && Array.isArray(mesh.faces) && mesh.faces.length > 0 && mesh.faces.length <= 250000
    && mesh.faces.every(f => Array.isArray(f) && f.length === 3 && f.every(i => Number.isInteger(i) && i >= 0 && i < mesh.vertices.length));
}

function parseProject(text: string): SavedProject {
  const project = JSON.parse(text) as SavedProject;
  if (project.schema !== 'edu3d-project' || project.version !== 1) throw new Error('Este archivo no es un proyecto Edu3d compatible (versión 1).');
  if (typeof project.name !== 'string' || !validMesh(project.sourceMesh)
      || !['mm', 'cm', 'in'].includes(project.source_units)
      || !project.analysis || !Array.isArray(project.analysis.dimensions) || project.analysis.dimensions.length !== 3
      || !project.analysis.dimensions.every(v => Number.isFinite(v) && v >= 0)
      || !Number.isInteger(project.analysis.triangles) || project.analysis.triangles < 1
      || typeof project.analysis.watertight !== 'boolean'
      || (project.analysis.volume !== null && !Number.isFinite(project.analysis.volume))
      || !Array.isArray(project.analysis.warnings) || !project.analysis.warnings.every(v => typeof v === 'string')) {
    throw new Error('El proyecto tiene datos incompletos o una malla no válida.');
  }
  if (project.recognition) {
    if (!Object.keys(shapeNames).includes(project.recognition.kind) || !project.params
      || !Object.values(project.params).every(Number.isFinite)
      || typeof project.recognition.description !== 'string' || !Number.isFinite(project.recognition.error_mm)) {
      throw new Error('Los parámetros guardados no son válidos.');
    }
    const transform = project.transform;
    if (transform && (!Array.isArray(transform) || transform.length !== 4 || !transform.every(row => Array.isArray(row) && row.length === 4 && row.every(Number.isFinite)))) {
      throw new Error('La transformación del proyecto no es válida.');
    }
  }
  if (project.operations !== undefined && (!Array.isArray(project.operations) || project.operations.length > 12
      || !project.operations.every(op => op && ['cut', 'add'].includes(op.mode) && ['cylinder', 'box'].includes(op.shape)
        && ['x', 'y', 'z'].includes(op.axis) && (op.shape !== 'box' || op.axis === 'z')
        && op.parameters && Object.values(op.parameters).every(Number.isFinite)))) {
    throw new Error('Las operaciones guardadas en este proyecto no son válidas.');
  }
  return project;
}

export default function App() {
  const [source, setSource] = useState<AnalyzeResult | null>(null);
  const [model, setModel] = useState<ModelPreview | null>(null);
  const [history, setHistory] = useState<ModelSpec[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [units, setUnits] = useState<Units>('mm');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [showModel, setShowModel] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [selected, setSelected] = useState<'mesh' | 'solid'>('solid');
  const [menu, setMenu] = useState(false);
  const [help, setHelp] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [activeView, setActiveView] = useState<ViewName>('iso');
  const [operationEditor, setOperationEditor] = useState<OperationDraft | null>(null);
  const [placingOperation, setPlacingOperation] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const viewer = useRef<ViewerHandle>(null);
  const dragDepth = useRef(0);
  const spec = history[historyIndex] || null;
  const changed = spec ? Object.keys(spec.parameters).some(key => draft[key] !== toDraft(spec)[key]) : false;

  useEffect(() => {
    fetch('/api/health').then(r => setApiOnline(r.ok)).catch(() => setApiOnline(false));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const closeOverlays = (event: KeyboardEvent) => { if (event.key === 'Escape') { setHelp(false); setMenu(false); } };
    window.addEventListener('keydown', closeOverlays);
    return () => window.removeEventListener('keydown', closeOverlays);
  }, []);

  const acceptResult = (result: AnalyzeResult) => {
    setSource(result); setModel(result.model); setUnits(result.source_units);
    const nextSpec = result.recognition ? { kind: result.recognition.kind, parameters: result.recognition.parameters, transform: result.recognition.transform, operations: result.recognition.operations || [], ...(result.recognition.kind === 'mesh' ? { reference: result.mesh } : {}) } : null;
    setHistory(nextSpec ? [nextSpec] : []); setHistoryIndex(nextSpec ? 0 : -1);
    setDraft(nextSpec ? toDraft(nextSpec) : {}); setShowOriginal(!result.recognition); setShowModel(true);
    setSelected(result.recognition ? 'solid' : 'mesh'); setWireframe(false); setActiveView('iso');
    setOperationEditor(null);
    setPlacingOperation(false);
    setApiOnline(true); setError(null);
    setTimeout(() => { viewer.current?.setView('iso'); viewer.current?.fit(); }, 100);
  };

  const importFile = async (file: File) => {
    if (busy) return;
    const isProject = /\.json$/i.test(file.name);
    if (file.size > (isProject ? MAX_PROJECT : MAX_FILE)) { setError(isProject ? 'El proyecto supera el límite de 80 MB.' : 'El STL supera el límite de 20 MB. Reduce la resolución de la malla antes de importarlo.'); return; }
    setError(null); setMenu(false);
    if (isProject) {
      setBusy('Abriendo proyecto…');
      try {
        const project = parseProject(await file.text());
        const newSpec = project.recognition && project.params ? { kind: project.recognition.kind, parameters: project.params, transform: project.transform, operations: project.operations || [], ...(project.recognition.kind === 'mesh' ? { reference: project.sourceMesh } : {}) } : null;
        const preview = newSpec ? await buildModel(newSpec) : null;
        acceptResult({ name: project.name, source_units: project.source_units, mesh: project.sourceMesh, analysis: project.analysis, recognition: project.recognition ? { ...project.recognition, parameters: project.params!, transform: project.transform, operations: project.operations || [] } : null, model: preview });
        setNotice('Proyecto abierto. Tus parámetros están listos.');
      } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo abrir el proyecto.'); }
      finally { setBusy(null); }
      return;
    }
    if (!/\.stl$/i.test(file.name)) { setError('Elige un archivo .stl o un proyecto .edu3d.json.'); return; }
    setBusy('Analizando la geometría…');
    try {
      const body = new FormData(); body.append('file', file); body.append('units', units);
      const result = await request<AnalyzeResult>('/api/analyze', { method: 'POST', body });
      acceptResult(result);
      setNotice(result.recognition ? 'Forma reconocida. Ya puedes editar sus medidas.' : 'Malla importada. Revisa el resultado del análisis.');
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo importar el archivo.'); }
    finally { setBusy(null); }
  };

  const loadDemo = async () => {
    setBusy('Preparando la pieza de ejemplo…'); setError(null);
    try { acceptResult(await request<AnalyzeResult>('/api/demo')); setNotice('Ejemplo cargado. Cambia una medida para probar la reconstrucción.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'No se pudo cargar el ejemplo.'); }
    finally { setBusy(null); }
  };

  const convertMesh = async () => {
    if (!source || busy || !source.analysis.watertight) return;
    const nextSpec: ModelSpec = { kind: 'mesh', parameters: { width: source.analysis.dimensions[0], depth: source.analysis.dimensions[1], height: source.analysis.dimensions[2] }, reference: source.mesh };
    setBusy('Creando el sólido de referencia…'); setError(null);
    try {
      const preview = await buildModel(nextSpec);
      const recognition = { kind: nextSpec.kind, parameters: nextSpec.parameters, error_mm: 0, description: 'Sólido de referencia que conserva las caras de la malla STL.' };
      setSource({ ...source, recognition, model: preview }); setModel(preview); setHistory([nextSpec]); setHistoryIndex(0);
      setDraft(toDraft(nextSpec)); setShowModel(true); setShowOriginal(true); setSelected('solid');
      setNotice('Sólido creado. Puedes exportar STEP o ajustar sus dimensiones globales.');
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo crear el sólido de referencia.'); }
    finally { setBusy(null); }
  };

  const applyParams = async () => {
    if (!spec || busy) return;
    const parameters: Record<string, number> = {};
    for (const [key, value] of Object.entries(draft)) {
      const numeric = Number(value);
      if (value.trim() === '' || !Number.isFinite(numeric) || (!['hole_x', 'hole_y'].includes(key) && numeric <= 0)) {
        setError(`Introduce una medida válida para «${parameterLabels[key] || key}».`); return;
      }
      parameters[key] = value === toDraft(spec)[key] ? spec.parameters[key] : numeric;
    }
    const nextSpec = { ...spec, parameters };
    setBusy('Reconstruyendo el sólido…'); setError(null);
    try {
      const preview = await buildModel(nextSpec);
      setModel(preview); setHistory([...history.slice(0, historyIndex + 1), nextSpec]); setHistoryIndex(historyIndex + 1);
      setDraft(toDraft(nextSpec)); setShowModel(true); setSelected('solid'); setNotice('Medidas aplicadas al sólido.');
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo reconstruir el sólido.'); }
    finally { setBusy(null); }
  };

  const restore = useCallback(async (index: number) => {
    if (busy || index < 0 || index >= history.length) return;
    setBusy('Actualizando el modelo…'); setError(null);
    try { setModel(await buildModel(history[index])); setHistoryIndex(index); setDraft(toDraft(history[index])); setOperationEditor(null); setPlacingOperation(false); }
    catch (err) { setError(err instanceof Error ? err.message : 'No se pudo restaurar la operación.'); }
    finally { setBusy(null); }
  }, [busy, history]);

  const newOperation = (mode: Operation['mode'], shape: Operation['shape']) => {
    if (!source || !spec || busy) return;
    if ((spec.operations?.length || 0) >= 12) { setError('Has alcanzado el máximo de 12 operaciones. Edita o elimina una operación para continuar.'); return; }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const vertex of source.mesh.vertices) for (let index = 0; index < 3; index++) {
      min[index] = Math.min(min[index], vertex[index]); max[index] = Math.max(max[index], vertex[index]);
    }
    const [x, y, z] = min.map((value, index) => (value + max[index]) / 2);
    const parameters: Record<string, number> = shape === 'cylinder'
      ? { x, y, z, diameter: 4, height: Math.max(source.analysis.dimensions[2] + 2, 2) }
      : { x, y, z, width: 8, depth: 8, height: Math.max(source.analysis.dimensions[2] + 2, 2) };
    setOperationEditor(operationToDraft({ mode, shape, axis: 'z', parameters }, null)); setPlacingOperation(false); setSelected('solid'); setError(null);
  };

  const commitOperations = async (operations: Operation[], message: string) => {
    if (!spec || busy) return;
    const nextSpec = { ...spec, operations };
    setBusy('Aplicando operaciones al sólido…'); setError(null);
    try {
      const preview = await buildModel(nextSpec);
      setModel(preview); setHistory([...history.slice(0, historyIndex + 1), nextSpec]); setHistoryIndex(historyIndex + 1);
      setDraft(toDraft(nextSpec)); setOperationEditor(null); setPlacingOperation(false); setShowModel(true); setSelected('solid'); setNotice(message);
      setShowOriginal(false);
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo aplicar la operación. Ajusta su posición y sus medidas.'); }
    finally { setBusy(null); }
  };

  const applyOperation = async () => {
    if (!operationEditor || !spec || busy) return;
    const parameters: Record<string, number> = {};
    const previous = operationEditor.index === null ? null : spec.operations?.[operationEditor.index];
    const previousDraft = previous ? operationToDraft(previous, operationEditor.index) : null;
    for (const [key, value] of Object.entries(operationEditor.parameters)) {
      const numeric = Number(value);
      if (value.trim() === '' || !Number.isFinite(numeric) || (!['x', 'y', 'z'].includes(key) && numeric <= 0)) {
        setError('Introduce coordenadas y dimensiones válidas para la operación.'); return;
      }
      parameters[key] = previous && value === previousDraft?.parameters[key] ? previous.parameters[key] : numeric;
    }
    const operation: Operation = { mode: operationEditor.mode, shape: operationEditor.shape, axis: operationEditor.shape === 'box' ? 'z' : operationEditor.axis, parameters };
    const operations = [...(spec.operations || [])];
    if (operationEditor.index === null) operations.push(operation);
    else operations[operationEditor.index] = operation;
    await commitOperations(operations, operationEditor.index === null ? 'Operación añadida. Puedes editarla desde el árbol de modelo.' : 'Operación actualizada.');
  };

  const deleteOperation = async () => {
    if (!spec || !operationEditor || operationEditor.index === null || busy) return;
    await commitOperations((spec.operations || []).filter((_, index) => index !== operationEditor.index), 'Operación eliminada. Puedes recuperarla con Deshacer.');
  };

  const placeOperation = (point: number[]) => {
    if (!operationEditor || !placingOperation || !source) return;
    const parameters: Record<string, string> = { ...operationEditor.parameters, x: String(Number(point[0].toFixed(4))), y: String(Number(point[1].toFixed(4))), z: String(Number(point[2].toFixed(4))) };
    if (operationEditor.mode === 'cut') {
      const axis = operationEditor.shape === 'cylinder' ? operationEditor.axis : 'z';
      const axisIndex = { x: 0, y: 1, z: 2 }[axis];
      let min = Infinity, max = -Infinity;
      for (const vertex of source.mesh.vertices) { min = Math.min(min, vertex[axisIndex]); max = Math.max(max, vertex[axisIndex]); }
      parameters[axis] = String(Number(((min + max) / 2).toFixed(4)));
      parameters.height = String(Number((max - min + 2).toFixed(4)));
    }
    setOperationEditor({ ...operationEditor, parameters }); setPlacingOperation(false);
    setNotice('Posición seleccionada. Ajusta las medidas y aplica la operación.');
  };

  const historyLabel = (item: ModelSpec, index: number) => {
    const previous = history[index];
    const count = item.operations?.length || 0, previousCount = previous?.operations?.length || 0;
    if (count > previousCount) return 'Añadir operación';
    if (count < previousCount) return 'Eliminar operación';
    if (JSON.stringify(item.operations || []) !== JSON.stringify(previous?.operations || [])) return 'Editar operación';
    return 'Editar medidas';
  };

  const saveProject = useCallback(() => {
    if (!source) return;
    const project: SavedProject = { schema: 'edu3d-project', version: 1, name: source.name, source_units: source.source_units, sourceMesh: source.mesh, analysis: source.analysis, recognition: source.recognition, params: spec?.parameters || null, transform: spec?.transform, operations: spec?.operations || [] };
    download(new Blob([JSON.stringify(project)], { type: 'application/json' }), `${baseName(source.name)}.edu3d.json`);
    setNotice('Proyecto guardado con la malla y los parámetros.'); setMenu(false);
  }, [source, spec]);

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') { event.preventDefault(); saveProject(); }
      if (event.target instanceof HTMLInputElement) return;
      if (event.key.toLowerCase() === 'z') { event.preventDefault(); void restore(historyIndex + (event.shiftKey ? 1 : -1)); }
      if (event.key.toLowerCase() === 'y') { event.preventDefault(); void restore(historyIndex + 1); }
    };
    window.addEventListener('keydown', shortcuts);
    return () => window.removeEventListener('keydown', shortcuts);
  }, [saveProject, restore, historyIndex]);

  const exportModel = async (format: 'step' | 'stl') => {
    if (!spec || busy) return;
    setBusy(format === 'step' ? 'Generando archivo STEP…' : 'Generando archivo STL…'); setError(null);
    try {
      const response = await fetch(`/api/export/${format}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
      if (!response.ok) { const data = await response.json(); throw new Error(typeof data.detail === 'string' ? data.detail : 'No se pudo exportar el sólido.'); }
      download(await response.blob(), `${baseName(source?.name || 'pieza')}.${format}`);
      setNotice(`Archivo ${format.toUpperCase()} exportado.`);
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo exportar el archivo.'); }
    finally { setBusy(null); setMenu(false); }
  };

  const setView = (view: ViewName) => { setActiveView(view); viewer.current?.setView(view); };
  const openImport = () => { setMenu(false); fileInput.current?.click(); };
  const sourceSize = source?.analysis.dimensions || [];

  return <div className="app-shell"
    onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDragLeave={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false); } }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); const file = event.dataTransfer.files[0]; if (file) void importFile(file); }}>
    <input ref={fileInput} type="file" accept=".stl" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} />
    <input ref={projectInput} type="file" accept=".json,.edu3d.json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} />

    <header className="topbar">
      <a className="brand" href="/" aria-label="Edu3d, inicio"><span className="brand-mark"><Box size={23} strokeWidth={1.7} /></span><span>edu<span className="brand-light">3d</span></span></a>
      <span className="header-divider" />
      <div className="document-heading"><span className="document-title">{source ? baseName(source.name) : 'Nueva pieza'}</span><span className="document-caption">Espacio personal <span>·</span> Diseño paramétrico</span></div>
      <div className="header-actions">
        <button className="icon-button help-button" onClick={() => setHelp(true)} aria-label="Ayuda y límites de conversión" title="Ayuda y límites"><CircleHelp size={19} /></button>
        <button className="button header-import" onClick={openImport} disabled={!!busy}><Upload size={15} /><span>Importar STL</span></button>
        <button className="button primary export-top" onClick={() => void exportModel('step')} disabled={!spec || !!busy || !model?.valid} title={!spec ? 'Importa una forma compatible para exportar' : 'Exportar sólido STEP'}><Download size={15} /><span>Exportar STEP</span></button>
        <div className="menu-wrap"><button className={`icon-button menu-button ${menu ? 'active' : ''}`} aria-label="Opciones de proyecto" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={21} /></button>
          {menu && <><button className="menu-backdrop" onClick={() => setMenu(false)} aria-label="Cerrar opciones" /><div className="project-menu">
            <div className="menu-label">PROYECTO</div>
            <button onClick={() => { projectInput.current?.click(); setMenu(false); }} disabled={!!busy}><FolderOpen size={16} /> Abrir proyecto <span>.json</span></button>
            <button onClick={saveProject} disabled={!source || !!busy}><Save size={16} /> Guardar proyecto <span>⌘/Ctrl S</span></button>
            <div className="menu-rule" /><button onClick={() => void exportModel('stl')} disabled={!spec || !!busy || !model?.valid}><ArrowDownToLine size={16} /> Exportar sólido STL</button>
            <button onClick={() => { setHelp(true); setMenu(false); }}><CircleHelp size={16} /> Acerca de la reconstrucción</button>
          </div></>}
        </div>
        <div className="avatar" title="Espacio personal">TÚ</div>
      </div>
    </header>

    <div className="workspace-toolbar">
      <div className="workspace-tab"><Box size={16} /><span>Estudio de pieza</span><span className="tab-count">1</span></div>
      <div className="toolbar-divider" />
      <button className="tool-icon" onClick={() => void restore(historyIndex - 1)} disabled={historyIndex <= 0 || !!busy} title="Deshacer (Ctrl Z)" aria-label="Deshacer"><Undo2 size={17} /></button>
      <button className="tool-icon" onClick={() => void restore(historyIndex + 1)} disabled={historyIndex >= history.length - 1 || !!busy} title="Rehacer (Ctrl Mayús Z)" aria-label="Rehacer"><Redo2 size={17} /></button>
      <div className="toolbar-divider" />
      <span className="workflow-crumb"><span className={source ? 'crumb-complete' : 'crumb-current'}>{source ? <Check size={12} /> : '1'}</span> Importar <ChevronRight size={12} /><span className={spec ? 'crumb-complete' : 'crumb-muted'}>{spec ? <Check size={12} /> : '2'}</span> Reconstruir <ChevronRight size={12} /><span className={spec ? 'crumb-current' : 'crumb-muted'}>3</span> Editar y exportar</span>
      <div className="toolbar-end"><span className="unit-indicator">Medidas en <strong>mm</strong></span><span className="early-label">VERSIÓN INICIAL</span></div>
    </div>

    <main className="workspace">
      <aside className="model-panel">
        <div className="panel-heading"><span>Modelo</span><Layers size={15} /></div>
        <div className="model-document"><ChevronDown size={13} /><FileBox size={16} /><span>{source ? baseName(source.name) : 'Nueva pieza'}</span></div>
        <div className="tree-group-label">GEOMETRÍA</div>
        <button className={`tree-row ${source && selected === 'mesh' ? 'selected' : ''} ${!source ? 'muted' : ''}`} onClick={() => source && setSelected('mesh')} disabled={!source}>
          <span className="tree-indent" /><ScanLine size={16} /><span>Malla de referencia</span><span className="tree-ext">STL</span>
        </button>
        {source && <button className="tree-visibility source-visibility" title={showOriginal ? 'Ocultar malla de referencia' : 'Mostrar malla de referencia'} onClick={() => setShowOriginal(!showOriginal)} aria-label={showOriginal ? 'Ocultar malla' : 'Mostrar malla'}>{showOriginal ? <Eye size={15} /> : <EyeOff size={15} />}</button>}
        <button className={`tree-row solid-row ${spec && selected === 'solid' ? 'selected' : ''} ${!spec ? 'muted' : ''}`} onClick={() => spec && setSelected('solid')} disabled={!spec}>
          <span className="tree-indent" /><Box size={16} /><span>{spec ? shapeNames[spec.kind] : 'Sólido paramétrico'}</span>{spec && <span className="solid-dot" />}
        </button>
        {spec && <button className="tree-visibility solid-visibility" title={showModel ? 'Ocultar sólido' : 'Mostrar sólido'} onClick={() => setShowModel(!showModel)} aria-label={showModel ? 'Ocultar sólido' : 'Mostrar sólido'}>{showModel ? <Eye size={15} /> : <EyeOff size={15} />}</button>}
        {!source && <p className="tree-placeholder">Tu pieza aparecerá aquí después de importar un STL.</p>}
        {spec && <><div className="tree-section-header"><span>OPERACIONES NUEVAS</span><span className="operation-count">{spec.operations?.length || 0}</span></div>
          <div className="added-operations-tree">{(spec.operations || []).map((operation, index) => <button aria-label={`Editar operación ${index + 1}: ${operationName(operation)}`} className={`added-operation-row ${operationEditor?.index === index ? 'selected' : ''}`} key={index} onClick={() => { setOperationEditor(operationToDraft(operation, index)); setPlacingOperation(false); setSelected('solid'); }} disabled={!!busy}><span className="operation-mode-icon">{operation.mode === 'cut' ? <Scissors size={13} /> : <Plus size={13} />}</span><span><strong>{operationName(operation)} {index + 1}</strong><small>{operation.shape === 'cylinder' ? `Ø ${n(operation.parameters.diameter)} · Eje ${operation.axis.toUpperCase()}` : `${n(operation.parameters.width)} × ${n(operation.parameters.depth)} × ${n(operation.parameters.height)}`} mm</small></span><Settings2 size={11} /></button>)}{!spec.operations?.length && <p className="added-operations-empty">Los detalles que añadas tendrán sus propios parámetros.</p>}</div></>}
        <div className="tree-section-header"><span>HISTORIAL EDU3D</span><span className="operation-count">{source ? historyIndex + 2 : 0}</span></div>
        {source ? <div className="history-list">
          <div className="history-item"><span className="history-node"><FileUp size={12} /></span><div><strong>Importación STL</strong><span>{n(source.analysis.triangles, 0)} triángulos</span></div><Check size={12} className="history-check" /></div>
          {spec && <div className="history-item"><span className="history-node teal"><Box size={12} /></span><div><strong>{spec.kind === 'mesh' ? 'Conversión de malla' : 'Reconstrucción'}</strong><span>{shapeLabels[spec.kind]}</span></div><Check size={12} className="history-check" /></div>}
          {history.slice(1).map((item, index) => <button className={`history-item history-button ${index + 1 > historyIndex ? 'future-history' : ''} ${index + 1 === historyIndex ? 'current-history' : ''}`} key={index} onClick={() => void restore(index + 1)} disabled={!!busy} title="Restaurar este estado del modelo"><span className="history-node"><Settings2 size={12} /></span><div><strong>{historyLabel(item, index)} {index + 1}</strong><span>{Object.entries(item.parameters).slice(0, 3).map(([key, value]) => `${parameterLetters[key]} ${n(value)}`).join(' · ')}</span></div></button>)}
        </div> : <div className="operations-empty"><span /><span /><span /></div>}
        <div className="sidebar-footer"><ShieldCheck size={16} /><div><strong>Tu espacio, tus piezas</strong><span>Guarda el proyecto para conservar<br />los parámetros de diseño.</span></div></div>
      </aside>

      <section className={`viewport-panel ${placingOperation ? 'placing-operation' : ''}`} aria-label="Área de diseño 3D">
        <Viewer ref={viewer} original={source?.mesh || null} model={model?.mesh || null} showOriginal={showOriginal} showModel={showModel} wireframe={wireframe} onSelect={setSelected} onPick={placeOperation} />{placingOperation && <div className="viewport-picking-hint"><MousePointer2 size={14} /><span>Haz clic sobre la pieza para situar la operación</span><button onClick={() => setPlacingOperation(false)} aria-label="Cancelar selección de posición"><X size={14} /></button></div>}
        <div className="viewport-label"><span className="view-status-dot" />{source ? 'Vista del modelo' : 'Espacio de diseño'}<span className="viewport-label-divider">/</span><span className="view-name">{activeView === 'iso' ? 'Isométrica' : activeView === 'front' ? 'Frontal' : activeView === 'top' ? 'Superior' : 'Derecha'}</span></div>
        <div className="view-cube" aria-label="Controles de vista"><button className={`cube-top ${activeView === 'top' ? 'active' : ''}`} onClick={() => setView('top')} title="Vista superior">SUP</button><button className={`cube-front ${activeView === 'front' ? 'active' : ''}`} onClick={() => setView('front')} title="Vista frontal">FRONT</button><button className={`cube-right ${activeView === 'right' ? 'active' : ''}`} onClick={() => setView('right')} title="Vista derecha">DER</button><button className="cube-iso" onClick={() => setView('iso')} title="Vista isométrica" aria-label="Vista isométrica"><Rotate3d size={16} /></button></div>
        {!source && !busy && <div className="empty-state"><div className="empty-art"><Box size={47} strokeWidth={1.25} /><span className="art-spark art-spark-a" /><span className="art-spark art-spark-b" /></div><div className="eyebrow">DE LA MALLA A TU PRÓXIMA PIEZA</div><h1>Dale nuevas medidas<br />a tus ideas.</h1><p>Importa un STL, reconstruye una forma compatible<br className="desktop-break" /> y conviértela en un sólido editable.</p><button className="button primary empty-import" onClick={openImport}><Upload size={17} /> Importar archivo STL <ArrowRight size={16} /></button><span className="drop-hint">o arrástralo aquí · hasta 20 MB</span><div className="empty-separator"><span /><span>¿Quieres explorarlo primero?</span><span /></div><button className="sample-button" onClick={() => void loadDemo()}><Box size={16} /> Probar pieza de ejemplo <ArrowRight size={14} /></button></div>}
        {busy && <div className="busy-overlay"><div className="busy-card"><LoaderCircle size={27} className="spin" /><strong>{busy}</strong><span>Procesando la geometría de tu pieza</span></div></div>}
        <div className="viewport-bottom"><div className="axis-labels"><span className="axis-z">Z</span><span className="axis-y">Y</span><span className="axis-x">X</span><Axis3d size={35} strokeWidth={1.1} /></div><div className="canvas-tools"><button className={wireframe ? 'active' : ''} onClick={() => setWireframe(!wireframe)} title="Alternar visualización de aristas" aria-label="Alternar malla de alambre" aria-pressed={wireframe}><Grid2X2 size={17} /></button><span /><button onClick={() => { setView('iso'); viewer.current?.fit(); }} title="Ajustar pieza a la vista" aria-label="Ajustar pieza a la vista"><Maximize size={17} /></button></div><span className="navigation-hint"><MousePointer2 size={12} /> Arrastra para girar <span>·</span> Rueda para acercar</span></div>
      </section>

      <aside className="properties-panel">
        <div className="panel-heading"><span>{spec ? 'Propiedades de la pieza' : source ? 'Análisis de la malla' : 'De STL a sólido'}</span><Settings2 size={15} /></div>
        <div className="properties-scroll">
          {spec ? <>
            <div className="shape-heading"><div className="shape-icon"><Box size={22} /></div><div><h2>{shapeNames[spec.kind]}</h2><span>{spec.kind === 'mesh' ? 'Geometría de la malla STL' : 'Sólido paramétrico'}</span></div><span className="shape-check"><Check size={13} /></span></div>
            <div className="recognition-badge"><CheckCircle2 size={14} /> {spec.kind === 'mesh' ? 'Sólido de referencia creado' : 'Forma compatible reconocida'}</div>{spec.kind === 'mesh' && <div className="mesh-conversion-note"><AlertCircle size={15} /><span>Conserva las caras de la malla. Permite cambiar dimensiones globales; no recupera bocetos ni agujeros independientes.</span></div>}
            <div className="property-section"><div className="section-title">{spec.kind === 'mesh' ? 'DIMENSIONES GLOBALES' : 'MEDIDAS'} <span>mm</span></div><p className="section-description">{spec.kind === 'mesh' ? 'Escala toda la pieza, incluidos los agujeros. Las medidas no son operaciones independientes.' : 'Ajusta los valores para reconstruir la pieza.'}</p>
              <form onSubmit={event => { event.preventDefault(); void applyParams(); }}>
                {Object.entries(draft).map(([key, value]) => <label className="parameter-field" key={key}><span>{parameterLabels[key] || key}</span><div className="number-input"><span className="parameter-letter">{parameterLetters[key] || '↔'}</span><input type="number" step="any" min={['hole_x', 'hole_y'].includes(key) ? undefined : 0.001} value={value} onChange={event => setDraft({ ...draft, [key]: event.target.value })} disabled={!!busy} aria-label={`${parameterLabels[key] || key} en milímetros`} /><span className="input-unit">mm</span></div></label>)}
                <button className="button primary apply-button" disabled={!!busy || !changed} type="submit"><Check size={15} /> Aplicar medidas</button>
                {changed && <button className="discard-button" type="button" onClick={() => setDraft(toDraft(spec))} disabled={!!busy}>Descartar cambios pendientes</button>}
              </form>
            </div>
            <OperationEditor draft={operationEditor} count={spec.operations?.length || 0} busy={!!busy} onNew={newOperation} onChange={setOperationEditor} onApply={() => void applyOperation()} onDelete={() => void deleteOperation()} onCancel={() => { setOperationEditor(null); setPlacingOperation(false); }} placing={placingOperation} onPlace={() => { setPlacingOperation(!placingOperation); if (!placingOperation) document.querySelector('.viewport-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }} operations={spec.operations || []} onSelect={index => { setOperationEditor(operationToDraft(spec.operations![index], index)); setPlacingOperation(false); }} />
            <div className="property-section"><div className="section-title">SÓLIDO RECONSTRUIDO</div><div className="metric-row"><span>Volumen</span><strong>{model ? n(model.volume / 1000, 3) : '—'} <small>cm³</small></strong></div><div className="metric-row"><span>Caras CAD</span><strong>{model ? n(model.faces, 0) : '—'}</strong></div><div className="metric-row"><span>Estado del sólido</span><strong className={model?.valid ? 'text-teal' : 'text-amber'}>{model?.valid ? 'Válido' : 'No válido'}</strong></div>{spec.kind !== 'mesh' ? <><div className="metric-row"><span>Error de ajuste inicial</span><strong>{n(source?.recognition?.error_mm || 0, 4)} <small>mm</small></strong></div><p className="metric-note">El error corresponde a la malla importada. Las medidas editadas definen un nuevo sólido.</p></> : <p className="metric-note">El STEP conserva superficies planas triangulares. No reconstruye superficies curvas analíticas ni el historial original.</p>}</div>
          </> : source ? <div className="unrecognized-card"><div className="unrecognized-icon"><ScanLine size={27} /></div><h2>Malla importada</h2><p>No se ha reconocido una forma paramétrica compatible con suficiente precisión.</p><div className="info-callout"><AlertCircle size={16} /><span>{source.analysis.watertight ? 'Puedes crear un sólido STEP que conserve las caras de la malla. Permite cambiar dimensiones globales; no recupera bocetos ni agujeros independientes.' : 'La malla no está cerrada. Puedes inspeccionarla y guardar el proyecto; necesita reparación antes de crear un sólido STEP.'}</span></div>{source.analysis.watertight && <button className="button primary convert-mesh-button" onClick={() => void convertMesh()} disabled={!!busy}><Box size={16} /> Crear sólido STEP</button>}<p className="section-description">La reconstrucción de bocetos y operaciones de piezas complejas requiere un trabajo posterior.</p></div> : <>
            <div className="intro-heading"><span className="intro-pill"><span /> TU TALLER PERSONAL</span><h2>Una nueva vida<br />para tus archivos STL.</h2><p>Recupera geometría útil para seguir diseñando e imprimir tu próxima versión.</p></div>
            <div className="onboarding-steps"><div className="onboarding-step"><span className="step-number active">1</span><div><strong>Importa tu pieza</strong><p>Usa un STL de tu ordenador.</p></div></div><div className="onboarding-step"><span className="step-number">2</span><div><strong>Reconoce su geometría</strong><p>Buscamos una forma sencilla que se ajuste a la malla.</p></div></div><div className="onboarding-step"><span className="step-number">3</span><div><strong>Edita y exporta</strong><p>Cambia las medidas y descarga un sólido STEP o STL.</p></div></div></div>
            <div className="import-unit-settings"><label htmlFor="import-units">Unidades del archivo STL</label><div className="select-wrap"><select id="import-units" value={units} onChange={event => setUnits(event.target.value as Units)}><option value="mm">Milímetros (mm)</option><option value="cm">Centímetros (cm)</option><option value="in">Pulgadas (in)</option></select><ChevronDown size={14} /></div><p>STL no guarda unidades. Elige las utilizadas al crear tu archivo.</p></div>
          </>}

          {source && <div className="property-section"><div className="section-title">MALLA DE REFERENCIA <span>STL</span></div><div className="metric-row"><span>Triángulos</span><strong>{n(source.analysis.triangles, 0)}</strong></div><div className="metric-row"><span>Malla cerrada</span><strong className={source.analysis.watertight ? 'text-teal' : 'text-amber'}>{source.analysis.watertight ? 'Sí' : 'No'}</strong></div><div className="dimension-label">Dimensiones originales · mm</div><div className="dimension-chips">{['X', 'Y', 'Z'].map((axis, index) => <span key={axis}><small>{axis}</small>{n(sourceSize[index] || 0)}</span>)}</div><div className="import-units-inline"><label htmlFor="next-import-units">Próximo STL</label><select id="next-import-units" value={units} onChange={event => setUnits(event.target.value as Units)} disabled={!!busy}><option value="mm">Milímetros</option><option value="cm">Centímetros</option><option value="in">Pulgadas</option></select></div>{source.analysis.warnings.map((warning, index) => <div className="warning-note" key={index}><AlertCircle size={13} /><span>{warning}</span></div>)}</div>}

          <div className="compatibility-card"><span className="section-title">FORMAS COMPATIBLES</span><div className="shape-types"><span><Box size={16} /> Bloques</span><span><Circle size={16} /> Cilindros</span><span><Circle size={16} /> Tubos</span><span><Grid2X2 size={16} /> Placas con agujero</span></div><p>Un STL contiene triángulos, no su historial de diseño. Reconstruimos formas compatibles; no recuperamos las operaciones originales.</p><button onClick={() => setHelp(true)}>Cómo funciona <ArrowRight size={12} /></button></div>
        </div>
        {source && <div className="properties-footer"><button className="button save-project-button" onClick={saveProject} disabled={!!busy}><FileJson size={15} /> Guardar proyecto</button><span>Conserva tus parámetros en .edu3d.json</span></div>}
      </aside>
    </main>

    <footer className="statusbar"><span className="status-left"><span className={`connection-dot ${apiOnline === false ? 'offline' : ''}`} />{busy ? busy : apiOnline === false ? 'No se puede conectar con el motor CAD' : source ? 'Modelo listo' : 'Listo para diseñar'}</span><span className="status-middle">{source ? `${n(source.analysis.triangles, 0)} triángulos · ${spec ? '1 sólido' : '0 sólidos'}` : 'Reconstrucción paramétrica para impresión 3D'}</span><span className="status-right"><span>XYZ</span><span>Milímetros</span><span>Edu3d 0.1</span></span></footer>
    {error && <div className="toast error-toast" role="alert"><AlertCircle size={19} /><span>{error}</span><button onClick={() => setError(null)} aria-label="Cerrar error"><X size={16} /></button></div>}
    {notice && !error && <div className="toast success-toast" role="status"><CheckCircle2 size={18} /><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Cerrar aviso"><X size={15} /></button></div>}
    {dragging && <div className="drop-overlay"><div><Upload size={40} /><h2>Suelta tu pieza aquí</h2><p>Archivo STL o proyecto .edu3d.json · hasta 20 MB</p></div></div>}
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={event => event.stopPropagation()}><button className="modal-close icon-button" aria-label="Cerrar ayuda" onClick={() => setHelp(false)}><X size={20} /></button><span className="help-brand"><Box size={25} /> Edu3d</span><h2 id="help-title">De STL a un sólido editable.</h2><p>Esta primera versión reconstruye bloques, cilindros, tubos y placas rectangulares con un agujero circular pasante. El reconocimiento es conservador. Para otras mallas cerradas, puedes crear un sólido STEP faceteado y modificar sus dimensiones globales.</p><div className="help-detail"><ScanLine size={21} /><div><strong>Un STL es una malla de triángulos</strong><p>No contiene medidas ni operaciones CAD. No es posible recuperar automáticamente su historial original.</p></div></div><div className="help-detail"><Box size={21} /><div><strong>STEP guarda la geometría del sólido</strong><p>Podrás abrirla en otro CAD. El archivo STEP no conserva el árbol de operaciones ni los parámetros de Edu3d.</p></div></div><div className="help-detail"><FileJson size={21} /><div><strong>Guarda también tu proyecto Edu3d</strong><p>El archivo .edu3d.json conserva la malla de referencia, las medidas y la posición. Usa «Abrir proyecto» para volver a editarlo.</p></div></div><p className="help-footnote">Las geometrías orgánicas, piezas complejas y conjuntos requieren otra estrategia de reconstrucción. Comprueba siempre las medidas y la orientación antes de imprimir.</p><button className="button primary" onClick={() => setHelp(false)}>Entendido <ArrowRight size={15} /></button></section></div>}
  </div>;
}
