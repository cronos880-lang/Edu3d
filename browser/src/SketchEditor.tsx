import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Plane, SketchEntity, SketchFeature, Vec2 } from './types';

export type SketchEditorProps = {
  sketch: SketchFeature;
  onChange: (sketch: SketchFeature) => void;
  onClose: () => void;
};

type Tool = 'select' | 'rectangle' | 'circle' | 'polygon' | 'pan';
type View = { x: number; y: number; span: number };
type Interaction =
  | { kind: 'draw'; tool: 'rectangle' | 'circle'; start: Vec2; current: Vec2 }
  | { kind: 'move'; entity: SketchEntity; start: Vec2; current: Vec2 }
  | { kind: 'pan'; start: Vec2; original: View; scale: number };

const ASPECT = 1.6;
const TOOL_LABELS: Record<Tool, string> = {
  select: 'Seleccionar', rectangle: 'Rectángulo', circle: 'Círculo', polygon: 'Polígono', pan: 'Desplazar vista',
};
const TOOL_ICONS: Record<Tool, string> = { select: '↖', rectangle: '▭', circle: '○', polygon: '⬠', pan: '✥' };
const round = (value: number) => Number(value.toFixed(5));
const newId = () => `profile-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

function translate(entity: SketchEntity, dx: number, dy: number): SketchEntity {
  return entity.type === 'polygon'
    ? { ...entity, points: entity.points.map(([x, y]) => [round(x + dx), round(y + dy)]) }
    : { ...entity, x: round(entity.x + dx), y: round(entity.y + dy) };
}

function bounds(entity: SketchEntity) {
  if (entity.type === 'rectangle') return { x: entity.x, y: entity.y, width: entity.width, height: entity.height };
  if (entity.type === 'circle') return { x: entity.x, y: entity.y, width: entity.radius * 2, height: entity.radius * 2 };
  if (!entity.points.length) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = entity.points.map(p => p[0]); const ys = entity.points.map(p => p[1]);
  const left = Math.min(...xs); const right = Math.max(...xs);
  const bottom = Math.min(...ys); const top = Math.max(...ys);
  return { x: (left + right) / 2, y: (bottom + top) / 2, width: right - left, height: top - bottom };
}

function polygonArea(points: Vec2[]) {
  return Math.abs(points.reduce((sum, [x, y], i) => {
    const next = points[(i + 1) % points.length];
    return sum + x * next[1] - next[0] * y;
  }, 0)) / 2;
}

function NumberField({ label, value, onCommit, min, step = 1 }: {
  label: string; value: number; onCommit: (value: number) => void; min?: number; step?: number;
}) {
  const [text, setText] = useState(String(round(value)));
  useEffect(() => setText(String(round(value))), [value]);
  function commit() {
    const next = Number(text);
    if (text.trim() && Number.isFinite(next) && (min === undefined || next >= min)) onCommit(next);
    else setText(String(round(value)));
  }
  return <label className="se-number"><span>{label}</span><input type="number" value={text} min={min} step={step}
    onChange={event => setText(event.target.value)} onBlur={commit}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); setText(String(round(value))); }
    }} /></label>;
}

export function SketchEditor({ sketch, onChange, onClose }: SketchEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const interaction = useRef<Interaction | null>(null);
  const currentSketch = useRef(sketch);
  currentSketch.current = sketch;
  const patternId = `sketch-grid-${useId().replace(/:/g, '')}`;
  const [tool, setTool] = useState<Tool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SketchEntity | null>(null);
  const [polygon, setPolygon] = useState<Vec2[]>([]);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, span: 160 });
  const [showGrid, setShowGrid] = useState(true);
  const [snap, setSnap] = useState(true);
  const [gridStep, setGridStep] = useState(5);
  const [drawCut, setDrawCut] = useState(false);
  const [notice, setNotice] = useState('');
  const selected = sketch.entities.find(entity => entity.id === selectedId);
  const height = view.span / ASPECT;
  const lineWidth = view.span / 650;

  useEffect(() => {
    setSelectedId(null); setPolygon([]); setDraft(null); setTool('select');
    interaction.current = null; setNotice('');
    fitView(); svgRef.current?.focus();
  }, [sketch.id]);

  function replaceEntity(entity: SketchEntity) {
    const source = currentSketch.current;
    onChange({ ...source, entities: source.entities.map(item => item.id === entity.id ? entity : item) });
  }

  function addEntity(entity: SketchEntity) {
    const source = currentSketch.current;
    onChange({ ...source, entities: [...source.entities, entity] });
    setSelectedId(entity.id); setDraft(null); setPolygon([]); setTool('select'); setNotice('');
  }

  function removeSelected() {
    if (!selectedId) return;
    const source = currentSketch.current;
    onChange({ ...source, entities: source.entities.filter(entity => entity.id !== selectedId) });
    setSelectedId(null); setDraft(null); interaction.current = null;
  }

  function chooseTool(next: Tool) {
    setTool(next); setDraft(null); setPolygon([]); setNotice(''); interaction.current = null;
    svgRef.current?.focus();
  }

  function position(event: { clientX: number; clientY: number }, shouldSnap = true): Vec2 {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return [0, 0];
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const quantize = (value: number) => shouldSnap && snap ? round(Math.round(value / gridStep) * gridStep) : round(value);
    return [quantize(point.x), quantize(-point.y)];
  }

  function drawnEntity(active: Extract<Interaction, { kind: 'draw' }>): SketchEntity {
    const [x, y] = active.start; const [endX, endY] = active.current;
    return active.tool === 'rectangle'
      ? { id: 'draft', type: 'rectangle', x: round((x + endX) / 2), y: round((y + endY) / 2), width: round(Math.abs(endX - x)), height: round(Math.abs(endY - y)), cut: drawCut }
      : { id: 'draft', type: 'circle', x, y, radius: round(Math.hypot(endX - x, endY - y)), cut: drawCut };
  }

  function finishPolygon() {
    const points = polygon.filter((point, i) => !i || point[0] !== polygon[i - 1][0] || point[1] !== polygon[i - 1][1]);
    if (points.length > 1 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1]) points.pop();
    if (points.length < 3 || polygonArea(points) < 1e-8) {
      setNotice('El polígono necesita al menos tres vértices y un área mayor que cero.'); return;
    }
    addEntity({ id: newId(), type: 'polygon', points, cut: drawCut });
  }

  function pointerDown(event: ReactPointerEvent<SVGSVGElement>, entity?: SketchEntity) {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault(); svgRef.current?.focus();
    const point = position(event);
    if (event.button === 1 || tool === 'pan' || (event.shiftKey && tool === 'select')) {
      interaction.current = { kind: 'pan', start: [event.clientX, event.clientY], original: { ...view }, scale: svgRef.current?.getScreenCTM()?.a || 1 };
    } else if (tool === 'select') {
      setSelectedId(entity?.id ?? null);
      if (entity) interaction.current = { kind: 'move', entity, start: point, current: point };
    } else if (tool === 'polygon') {
      if (event.detail > 1) return;
      if (polygon.length >= 3 && Math.hypot(point[0] - polygon[0][0], point[1] - polygon[0][1]) < view.span / 60) finishPolygon();
      else setPolygon(points => [...points, point]);
      return;
    } else {
      interaction.current = { kind: 'draw', tool, start: point, current: point };
      setDraft(drawnEntity(interaction.current)); setSelectedId(null);
    }
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const point = position(event); setCursor(point);
    const active = interaction.current;
    if (!active) return;
    if (active.kind === 'pan') {
      setView({ ...active.original,
        x: active.original.x - (event.clientX - active.start[0]) / active.scale,
        y: active.original.y + (event.clientY - active.start[1]) / active.scale });
    } else {
      active.current = point;
      setDraft(active.kind === 'draw' ? drawnEntity(active) : translate(active.entity, point[0] - active.start[0], point[1] - active.start[1]));
    }
  }

  function pointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const active = interaction.current;
    interaction.current = null;
    if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId);
    if (!active || active.kind === 'pan') return;
    active.current = position(event);
    if (active.kind === 'move') {
      if (active.current[0] !== active.start[0] || active.current[1] !== active.start[1]) replaceEntity(translate(active.entity, active.current[0] - active.start[0], active.current[1] - active.start[1]));
      setDraft(null); return;
    }
    const entity = drawnEntity(active);
    const valid = entity.type === 'circle' ? entity.radius > 0 : entity.type === 'rectangle' && entity.width > 0 && entity.height > 0;
    if (valid) addEntity({ ...entity, id: newId() });
    else { setDraft(null); setNotice('Arrastra para definir un contorno con dimensiones mayores que cero.'); }
  }

  function fitView() {
    if (!sketch.entities.length) { setView({ x: 0, y: 0, span: 160 }); return; }
    const boxes = sketch.entities.map(bounds);
    const left = Math.min(...boxes.map(box => box.x - box.width / 2));
    const right = Math.max(...boxes.map(box => box.x + box.width / 2));
    const bottom = Math.min(...boxes.map(box => box.y - box.height / 2));
    const top = Math.max(...boxes.map(box => box.y + box.height / 2));
    setView({ x: (left + right) / 2, y: (bottom + top) / 2, span: Math.max(10, right - left, (top - bottom) * ASPECT) * 1.35 });
  }

  function zoom(factor: number) { setView(previous => ({ ...previous, span: Math.min(20000, Math.max(2, previous.span * factor)) })); }

  function keyDown(event: ReactKeyboardEvent) {
    if ((event.target as HTMLElement).closest('input, select, textarea') || event.ctrlKey || event.metaKey || event.altKey) return;
    const keys: Partial<Record<string, Tool>> = { v: 'select', r: 'rectangle', c: 'circle', p: 'polygon', h: 'pan' };
    if (event.key === 'Escape') { setDraft(null); setPolygon([]); interaction.current = null; setTool('select'); setNotice(''); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); }
    else if (event.key === 'Enter' && tool === 'polygon') { event.preventDefault(); finishPolygon(); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(0.8); }
    else if (event.key === '-') { event.preventDefault(); zoom(1.25); }
    else if (keys[event.key.toLowerCase()]) { event.preventDefault(); chooseTool(keys[event.key.toLowerCase()]!); }
  }

  function renderEntity(entity: SketchEntity, preview = false) {
    const isSelected = selectedId === entity.id;
    const color = preview ? '#d97706' : isSelected ? '#2563eb' : entity.cut ? '#b45309' : '#334155';
    const props = { fill: preview || isSelected ? '#3b82f61c' : entity.cut ? '#f59e0b12' : '#64748b0b', stroke: color,
      strokeWidth: lineWidth * (isSelected ? 2 : 1.3), strokeDasharray: entity.cut ? `${lineWidth * 5} ${lineWidth * 3}` : undefined };
    return <g key={entity.id} style={{ cursor: tool === 'select' ? 'move' : undefined }}
      onPointerDown={event => {
        if (tool === 'select' && !preview) { event.stopPropagation(); pointerDown(event as unknown as ReactPointerEvent<SVGSVGElement>, entity); }
      }} pointerEvents={preview ? 'none' : 'auto'}>
      {entity.type === 'rectangle' ? <rect x={entity.x - entity.width / 2} y={entity.y - entity.height / 2} width={entity.width} height={entity.height} {...props} />
        : entity.type === 'circle' ? <circle cx={entity.x} cy={entity.y} r={entity.radius} {...props} />
          : <polygon points={entity.points.map(point => point.join(',')).join(' ')} {...props} />}
      {isSelected && !preview && (() => {
        const box = bounds(entity);
        return <circle cx={box.x} cy={box.y} r={lineWidth * 2.7} fill={color} stroke="white" strokeWidth={lineWidth} />;
      })()}
    </g>;
  }

  function scalePolygon(entity: Extract<SketchEntity, { type: 'polygon' }>, dimension: 'width' | 'height', value: number) {
    const box = bounds(entity); const old = box[dimension]; if (!old) return;
    replaceEntity({ ...entity, points: entity.points.map(([x, y]) => dimension === 'width'
      ? [round(box.x + (x - box.x) * value / old), y] : [x, round(box.y + (y - box.y) * value / old)]) });
  }

  const instructions = tool === 'polygon' ? 'Haz clic para añadir vértices. Cierra sobre el primer punto o pulsa Enter.'
    : tool === 'rectangle' ? 'Arrastra entre dos esquinas. Las coordenadas del rectángulo indican su centro.'
      : tool === 'circle' ? 'Arrastra desde el centro hasta el borde del círculo.'
        : tool === 'pan' ? 'Arrastra para desplazar la vista. Usa la rueda para acercar o alejar.'
          : 'Selecciona un contorno para editarlo; arrastra para moverlo. Supr elimina. Mayús + arrastrar desplaza la vista.';

  return <div className="sketch-editor" role="dialog" aria-modal="true" aria-label={`Editar boceto ${sketch.name}`} onKeyDown={keyDown}>
    <style>{styles}</style>
    <header className="se-header"><div><span className="se-eyebrow">EDITOR DE BOCETOS · mm</span><h2>{sketch.name}</h2></div>
      <button className="se-primary" onClick={onClose}>Terminar boceto <span aria-hidden="true">✓</span></button></header>
    <div className="se-toolbar" role="toolbar" aria-label="Herramientas de boceto">
      <div className="se-tools">{(Object.keys(TOOL_LABELS) as Tool[]).map(item => <button key={item} title={`${TOOL_LABELS[item]} (${({ select: 'V', rectangle: 'R', circle: 'C', polygon: 'P', pan: 'H' })[item]})`}
        aria-pressed={tool === item} className={tool === item ? 'se-tool active' : 'se-tool'} onClick={() => chooseTool(item)}><span aria-hidden="true">{TOOL_ICONS[item]}</span>{TOOL_LABELS[item]}</button>)}</div>
      <button className="se-danger" disabled={!selected} onClick={removeSelected}>Eliminar</button>
      {tool === 'polygon' && <button disabled={polygon.length < 3} onClick={finishPolygon}>Cerrar polígono ({polygon.length})</button>}
    </div>
    <div className="se-content"><div className="se-workspace">
      <div className="se-view-controls"><label><input type="checkbox" checked={showGrid} onChange={event => setShowGrid(event.target.checked)} />Cuadrícula</label>
        <label><input type="checkbox" checked={snap} onChange={event => setSnap(event.target.checked)} />Ajustar</label>
        <label>Paso <select aria-label="Paso de cuadrícula en milímetros" value={gridStep} onChange={event => setGridStep(Number(event.target.value))}>{[0.1, 0.5, 1, 2, 5, 10, 20].map(step => <option key={step} value={step}>{step} mm</option>)}</select></label>
        <span className="se-spacer" /><button onClick={() => zoom(0.8)} aria-label="Acercar">+</button><button onClick={() => zoom(1.25)} aria-label="Alejar">−</button><button onClick={fitView}>Encuadrar</button></div>
      <div className="se-canvas"><svg ref={svgRef} viewBox={`${view.x - view.span / 2} ${-view.y - height / 2} ${view.span} ${height}`}
        tabIndex={0} role="img" aria-label={`Plano ${sketch.plane}. ${instructions}`}
        style={{ cursor: tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }}
        onPointerDown={event => pointerDown(event)} onPointerMove={pointerMove} onPointerUp={pointerUp}
        onPointerCancel={() => { interaction.current = null; setDraft(null); }}
        onDoubleClick={event => { if (tool === 'polygon') { event.preventDefault(); finishPolygon(); } }}
        onWheel={event => {
          const point = position(event, false); const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15;
          setView(previous => { const span = Math.min(20000, Math.max(2, previous.span * factor)); const ratio = span / previous.span;
            return { x: point[0] + (previous.x - point[0]) * ratio, y: point[1] + (previous.y - point[1]) * ratio, span }; });
        }}>
        <defs><pattern id={patternId} width={gridStep} height={gridStep} patternUnits="userSpaceOnUse"><path d={`M ${gridStep} 0 L 0 0 0 ${gridStep}`} fill="none" stroke="#d9e1e9" strokeWidth={lineWidth * 0.4} /></pattern></defs>
        {showGrid && view.span / gridStep < 1500 && <rect x={view.x - view.span / 2} y={-view.y - height / 2} width={view.span} height={height} fill={`url(#${patternId})`} pointerEvents="none" />}
        <line x1={view.x - view.span / 2} x2={view.x + view.span / 2} y1={0} y2={0} stroke="#dca6a6" strokeWidth={lineWidth * 0.8} pointerEvents="none" />
        <line y1={-view.y - height / 2} y2={-view.y + height / 2} x1={0} x2={0} stroke="#98b9ae" strokeWidth={lineWidth * 0.8} pointerEvents="none" />
        <g transform="scale(1,-1)">{sketch.entities.filter(entity => draft?.id !== entity.id).map(entity => renderEntity(entity))}{draft && renderEntity(draft, true)}
          {polygon.length > 0 && <g pointerEvents="none"><polyline points={[...polygon, ...(cursor ? [cursor] : [])].map(point => point.join(',')).join(' ')} fill="none" stroke="#d97706" strokeWidth={lineWidth * 1.5} />
            {cursor && <line x1={cursor[0]} y1={cursor[1]} x2={polygon[0][0]} y2={polygon[0][1]} stroke="#d97706" strokeWidth={lineWidth} strokeDasharray={`${lineWidth * 4} ${lineWidth * 3}`} />}
            {polygon.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={lineWidth * (i === 0 ? 4 : 2.5)} fill={i === 0 ? '#f59e0b' : '#d97706'} stroke="white" strokeWidth={lineWidth} />)}</g>}
        </g>
        <circle cx={0} cy={0} r={lineWidth * 1.8} fill="#64748b" pointerEvents="none" />
      </svg><span className="se-plane-badge">{sketch.plane} · {sketch.plane === 'XY' ? 'X / Y' : sketch.plane === 'XZ' ? 'X / Z' : 'Y / Z'}</span></div>
      <div className="se-status"><span aria-live="polite">{notice || instructions}</span><span>{cursor ? `${cursor[0].toFixed(2)}, ${cursor[1].toFixed(2)} mm` : 'Coordenadas en mm'} · {Math.round(160 / view.span * 100)}%</span></div>
    </div><aside className="se-inspector" aria-label="Propiedades del boceto">
      <section><h3>Boceto</h3><label className="se-full-field">Nombre<input value={sketch.name} onChange={event => onChange({ ...sketch, name: event.target.value })} /></label>
        <label className="se-full-field">Plano<select aria-label="Plano del boceto" value={sketch.plane} onChange={event => onChange({ ...sketch, plane: event.target.value as Plane })}><option value="XY">XY · planta</option><option value="XZ">XZ · frontal</option><option value="YZ">YZ · lateral</option></select></label>
        <NumberField label="Desplazamiento del plano (mm)" value={sketch.offset} onCommit={offset => onChange({ ...sketch, offset })} />
        {tool !== 'select' && tool !== 'pan' && <label className="se-checkbox"><input type="checkbox" checked={drawCut} onChange={event => setDrawCut(event.target.checked)} />Dibujar como hueco</label>}</section>
      <section><h3>{selected ? `${TOOL_LABELS[selected.type]} seleccionado` : 'Propiedades del contorno'}</h3>
        {selected ? <><label className="se-checkbox"><input type="checkbox" checked={Boolean(selected.cut)} onChange={event => replaceEntity({ ...selected, cut: event.target.checked })} />Hueco · restar al perfil</label>
          {selected.type !== 'polygon' ? <><div className="se-field-grid"><NumberField label="Centro X (mm)" value={selected.x} onCommit={x => replaceEntity({ ...selected, x })} /><NumberField label="Centro Y (mm)" value={selected.y} onCommit={y => replaceEntity({ ...selected, y })} /></div>
            {selected.type === 'rectangle' ? <div className="se-field-grid"><NumberField label="Ancho (mm)" value={selected.width} min={0.001} step={0.1} onCommit={width => replaceEntity({ ...selected, width })} /><NumberField label="Alto (mm)" value={selected.height} min={0.001} step={0.1} onCommit={height => replaceEntity({ ...selected, height })} /></div>
              : <><NumberField label="Radio (mm)" value={selected.radius} min={0.001} step={0.1} onCommit={radius => replaceEntity({ ...selected, radius })} /><p className="se-help">Diámetro: {round(selected.radius * 2)} mm</p></>}</>
            : <><div className="se-field-grid"><NumberField label="Centro X (mm)" value={bounds(selected).x} onCommit={x => replaceEntity(translate(selected, x - bounds(selected).x, 0))} /><NumberField label="Centro Y (mm)" value={bounds(selected).y} onCommit={y => replaceEntity(translate(selected, 0, y - bounds(selected).y))} />
              <NumberField label="Ancho (mm)" value={bounds(selected).width} min={0.001} step={0.1} onCommit={width => scalePolygon(selected, 'width', width)} /><NumberField label="Alto (mm)" value={bounds(selected).height} min={0.001} step={0.1} onCommit={height => scalePolygon(selected, 'height', height)} /></div>
              <details className="se-vertices"><summary>{selected.points.length} vértices · editar coordenadas</summary>{selected.points.map((point, index) => <div className="se-field-grid" key={`${selected.id}-${index}`}><NumberField label={`V${index + 1} · X`} value={point[0]} onCommit={x => replaceEntity({ ...selected, points: selected.points.map((p, i) => i === index ? [x, p[1]] : p) })} /><NumberField label={`V${index + 1} · Y`} value={point[1]} onCommit={y => replaceEntity({ ...selected, points: selected.points.map((p, i) => i === index ? [p[0], y] : p) })} /></div>)}</details></>}
          <button className="se-delete-wide se-danger" onClick={removeSelected}>Eliminar contorno</button></>
          : <p className="se-help">Selecciona una figura en el plano o en la lista para introducir medidas exactas.</p>}</section>
      <section><h3>Contornos <span className="se-count">{sketch.entities.length}</span></h3><div className="se-entity-list">{sketch.entities.length ? sketch.entities.map((entity, index) => <button key={entity.id} className={selectedId === entity.id ? 'selected' : ''} aria-pressed={selectedId === entity.id}
        onClick={() => { chooseTool('select'); setSelectedId(entity.id); }}><span>{TOOL_ICONS[entity.type]} {TOOL_LABELS[entity.type]} {index + 1}</span><small>{entity.cut ? 'Hueco' : 'Perfil'}</small></button>) : <p className="se-help">Dibuja el primer perfil con las herramientas superiores.</p>}</div></section>
    </aside></div>
  </div>;
}

const styles = `
.sketch-editor{position:fixed;inset:18px;z-index:1000;display:flex;flex-direction:column;background:#fff;color:#1e293b;border:1px solid #cbd5e1;border-radius:14px;box-shadow:0 20px 100px #0f172a66;font:13px/1.45 system-ui,-apple-system,sans-serif;overflow:hidden}
.sketch-editor *{box-sizing:border-box}.sketch-editor button,.sketch-editor input,.sketch-editor select{font:inherit}.sketch-editor button{border:1px solid #d7dfe7;background:#fff;color:#334155;border-radius:6px;padding:7px 11px;cursor:pointer;white-space:nowrap}.sketch-editor button:hover{background:#f1f5f9}.sketch-editor button:disabled{opacity:.4;cursor:default}.sketch-editor button:focus-visible,.sketch-editor input:focus-visible,.sketch-editor select:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}.sketch-editor input:not([type=checkbox]),.sketch-editor select{min-width:0;width:100%;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#0f172a;padding:7px 8px}.sketch-editor input[type=checkbox]{accent-color:#2563eb}
.se-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 22px;border-bottom:1px solid #e2e8f0}.se-eyebrow{font-size:10px;letter-spacing:1.8px;color:#64748b;font-weight:700}.se-header h2{font-size:19px;margin:3px 0 0;line-height:1.25}.sketch-editor .se-primary{background:#2563eb;color:#fff;border-color:#2563eb;font-weight:600;padding:10px 15px}.sketch-editor .se-primary:hover{background:#1d4ed8}.se-primary span{margin-left:10px}
.se-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid #e2e8f0;background:#f8fafc}.se-tools{display:flex;gap:5px;flex-wrap:wrap}.se-tool span{font-size:20px;line-height:12px;vertical-align:middle;margin-right:7px}.sketch-editor .se-tool.active{background:#eff6ff;border-color:#93c5fd;color:#1d4ed8}.sketch-editor .se-danger{color:#b91c1c}.se-content{display:flex;flex:1;min-height:0}.se-workspace{display:flex;flex-direction:column;flex:1;min-width:0;background:#f8fafc}.se-view-controls{display:flex;align-items:center;gap:12px;padding:9px 14px;border-bottom:1px solid #e2e8f0;flex-wrap:wrap}.se-view-controls label{display:flex;align-items:center;gap:5px;font-size:12px}.se-view-controls select{width:auto;padding:4px 7px}.se-view-controls button{padding:4px 9px}.se-spacer{flex:1}.se-canvas{position:relative;flex:1;min-height:240px;overflow:hidden;background:#fbfcfe}.se-canvas svg{display:block;width:100%;height:100%;touch-action:none;outline:none}.se-canvas svg:focus-visible{box-shadow:inset 0 0 0 2px #93c5fd}.se-plane-badge{position:absolute;left:14px;bottom:13px;background:#ffffffe6;border:1px solid #e2e8f0;padding:4px 8px;border-radius:5px;font-size:11px;color:#64748b;pointer-events:none}.se-status{min-height:43px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:9px 14px;font-size:11px;color:#64748b;border-top:1px solid #e2e8f0}.se-status>span:last-child{white-space:nowrap;font-variant-numeric:tabular-nums}
.se-inspector{width:280px;flex:none;border-left:1px solid #e2e8f0;overflow:auto;background:#fff}.se-inspector section{padding:17px;border-bottom:1px solid #e2e8f0}.se-inspector h3{display:flex;align-items:center;justify-content:space-between;font-size:12px;margin:0 0 13px;font-weight:700;color:#334155}.se-number,.se-full-field{display:flex;flex-direction:column;gap:5px;margin-bottom:11px;font-size:11px;color:#64748b}.se-number input{font-variant-numeric:tabular-nums}.se-field-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}.se-checkbox{display:flex;gap:7px;align-items:center;font-size:12px;margin:0 0 13px;color:#475569}.se-help{font-size:12px;color:#64748b;line-height:1.6;margin:5px 0 9px}.se-delete-wide{width:100%;margin-top:7px}.se-count{font-size:11px;background:#f1f5f9;padding:2px 7px;border-radius:10px;color:#64748b}.se-entity-list{display:flex;flex-direction:column;gap:6px}.se-entity-list button{display:flex;align-items:center;justify-content:space-between;width:100%;text-align:left}.se-entity-list button small{font-size:10px;color:#64748b}.sketch-editor .se-entity-list button.selected{background:#eff6ff;border-color:#93c5fd;color:#1d4ed8}.se-vertices summary{cursor:pointer;font-size:11px;color:#64748b;padding:5px 0 12px}.se-vertices .se-number{margin-bottom:7px}
@media(max-width:850px){.sketch-editor{inset:6px;border-radius:9px}.se-inspector{width:230px}.se-header{padding:12px 15px}.se-toolbar{padding:8px}.se-tool{font-size:11px!important;padding:6px 8px!important}.se-status{display:block}.se-status>span{display:block}}
@media(max-width:600px){.se-content{flex-direction:column}.se-inspector{width:100%;max-height:31vh;border-left:0;border-top:1px solid #e2e8f0;display:flex;flex-wrap:wrap}.se-inspector section{flex:1;min-width:220px}.se-workspace{min-height:300px}.se-canvas{min-height:180px}.se-header h2{font-size:15px}.se-header .se-primary{font-size:12px;padding:8px}.se-view-controls{gap:7px;padding:6px}.se-tools{gap:3px}.se-tool span{margin-right:3px}.se-toolbar{gap:5px}.se-status{min-height:36px;padding:6px 10px}}
`;

export default SketchEditor;
