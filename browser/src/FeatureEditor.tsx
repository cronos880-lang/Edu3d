import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Feature, Mode, Plane, RenderBody, Selection, SketchFeature, Vec3 } from './types';

export type FeatureEditorProps = {
  feature: Feature;
  features: Feature[];
  bodies: RenderBody[];
  selection: Selection | null;
  busy: boolean;
  onApply: (feature: Feature) => void;
  onCancel: () => void;
  onEditSketch?: (sketch: SketchFeature) => void;
};

const TITLES: Record<Feature['type'], string> = {
  primitive: 'Sólido básico', sketch: 'Croquis', extrude: 'Extrusión',
  revolve: 'Revolución', import: 'Archivo importado', transform: 'Transformar',
  fillet: 'Redondeo', chamfer: 'Chaflán', shell: 'Vaciado', boolean: 'Combinar cuerpos',
  pattern: 'Patrón', mirror: 'Simetría',
};
const PLANES: Plane[] = ['XY', 'XZ', 'YZ'];
const MODE_LABELS: Record<Mode, string> = {
  new: 'Nuevo cuerpo', add: 'Añadir material', cut: 'Quitar material', intersect: 'Intersección',
};
const formatNumber = (value: number) => Number.isFinite(value) ? String(value) : '';

function NumberField({ label, value, onChange, min, max, step = 'any', unit = 'mm' }: {
  label: string; value: number; onChange: (value: number) => void;
  min?: number; max?: number; step?: number | 'any'; unit?: string;
}) {
  const [text, setText] = useState(() => formatNumber(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(formatNumber(value)); }, [value]);
  return <label className="field number-field">
    <span>{label}{unit && <small> {unit}</small>}</span>
    <input type="number" value={text} min={min} max={max} step={step} required
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; setText(formatNumber(value)); }}
      onChange={event => {
        const next = event.currentTarget.value;
        setText(next);
        onChange(next.trim() === '' ? NaN : Number(next));
      }} />
  </label>;
}

function VectorFields({ label, value, onChange, unit = 'mm' }: {
  label: string; value: Vec3; onChange: (value: Vec3) => void; unit?: string;
}) {
  return <fieldset className="vector-fields">
    <legend>{label}{unit && <small> ({unit})</small>}</legend>
    <div className="vector-grid vector">{value.map((coordinate, index) =>
      <NumberField key={index} label={'XYZ'[index]} value={coordinate} unit=""
        min={-1_000_000} max={1_000_000}
        onChange={next => {
          const coordinates = [...value] as Vec3;
          coordinates[index] = next;
          onChange(coordinates);
        }} />
    )}</div>
  </fieldset>;
}

function hasNonfiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonfiniteNumber);
  if (value && typeof value === 'object') return Object.values(value).some(hasNonfiniteNumber);
  return false;
}

function selectedIndices(feature: Feature): number[] | undefined {
  if (feature.type === 'fillet' || feature.type === 'chamfer') return feature.edges;
  if (feature.type === 'shell') return feature.faces;
  return undefined;
}

export function FeatureEditor({ feature, features, bodies, selection, busy, onApply, onCancel, onEditSketch }: FeatureEditorProps) {
  const [draft, setDraft] = useState<Feature>(() => structuredClone(feature));
  const [indicesText, setIndicesText] = useState(() => selectedIndices(feature)?.map(index => index + 1).join(', ') ?? '');
  const [indicesError, setIndicesError] = useState('');
  const [error, setError] = useState('');
  const indicesHelpId = useId();

  useEffect(() => {
    setDraft(structuredClone(feature));
    setIndicesText(selectedIndices(feature)?.map(index => index + 1).join(', ') ?? '');
    setIndicesError('');
    setError('');
  }, [feature]);

  const previousFeatures = useMemo(() => {
    const index = features.findIndex(item => item.id === feature.id);
    return index < 0 ? features : features.slice(0, index);
  }, [features, feature.id]);
  const sketches = previousFeatures.filter((item): item is SketchFeature => item.type === 'sketch' && !item.suppressed);
  const bodyChoices = useMemo(() => {
    const previousIds = new Set(previousFeatures.map(item => item.id));
    const choices = new Map<string, string>();
    for (const body of bodies) {
      if (body.id !== feature.id && (previousIds.has(body.id) || !features.some(item => item.id === feature.id))) {
        choices.set(body.id, body.name);
      }
    }
    for (const item of previousFeatures) {
      if (item.suppressed) continue;
      if (item.type === 'import' || ((item.type === 'primitive' || item.type === 'extrude' || item.type === 'revolve') && item.mode === 'new')) {
        if (!choices.has(item.id)) choices.set(item.id, item.name);
      }
    }
    return choices;
  }, [bodies, previousFeatures, features, feature.id]);

  function update(patch: Partial<Feature>) {
    setDraft(current => ({ ...current, ...patch }) as Feature);
    setError('');
  }

  function updateTarget(target: string) {
    if (draft.type === 'fillet' || draft.type === 'chamfer') update({ target, edges: undefined });
    else if (draft.type === 'shell') update({ target, faces: undefined });
    else update({ target });
    setIndicesText('');
    setIndicesError('');
  }

  function bodySelector(label: string, value: string | undefined, onChange: (value: string) => void, excluded?: string) {
    const available = [...bodyChoices].filter(([id]) => id !== excluded);
    return <label className="field">
      <span>{label}</span>
      <select aria-label={label} value={value ?? ''} required onChange={event => onChange(event.currentTarget.value)}>
        <option value="" disabled>Selecciona un cuerpo</option>
        {value && !bodyChoices.has(value) && <option value={value}>{features.find(item => item.id === value)?.name ?? 'Cuerpo actual'} · referencia guardada</option>}
        {available.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
      {!available.length && !value && <small className="field-help">Crea o importa un cuerpo antes de esta operación.</small>}
    </label>;
  }

  function modeFields(mode: Mode, target: string | undefined) {
    return <>
      <label className="field"><span>Resultado</span>
        <select aria-label="Resultado" value={mode} onChange={event => {
          const next = event.currentTarget.value as Mode;
          update({ mode: next, target: next === 'new' ? undefined : (target || bodyChoices.keys().next().value || '') });
        }}>
          {(Object.keys(MODE_LABELS) as Mode[]).map(value => <option key={value} value={value}>{MODE_LABELS[value]}</option>)}
        </select>
      </label>
      {mode !== 'new' && bodySelector('Cuerpo de destino', target, value => update({ target: value }))}
    </>;
  }

  function sketchSelector(value: string) {
    return <label className="field"><span>Croquis de origen</span>
      <select aria-label="Croquis de origen" value={value} required onChange={event => update({ sketchId: event.currentTarget.value })}>
        <option value="" disabled>Selecciona un croquis</option>
        {value && !sketches.some(item => item.id === value) && <option value={value}>Croquis actual · referencia guardada</option>}
        {sketches.map(sketch => <option key={sketch.id} value={sketch.id}>{sketch.name}</option>)}
      </select>
      {!sketches.length && <small className="field-help">Añade un croquis antes de esta operación.</small>}
    </label>;
  }

  function planeSelector(value: Plane) {
    return <label className="field"><span>Plano</span>
      <select aria-label="Plano" value={value} onChange={event => update({ plane: event.currentTarget.value as Plane })}>
        {PLANES.map(plane => <option key={plane} value={plane}>{plane}</option>)}
      </select>
    </label>;
  }

  function usePickedPoint(onChange: (point: Vec3) => void) {
    if (!selection?.point) return null;
    return <button type="button" className="secondary small" onClick={() => onChange([...selection.point!] as Vec3)}>Usar punto seleccionado</button>;
  }

  function topologyFields(kind: 'edge' | 'face', target: string) {
    const isFace = kind === 'face';
    const matchingSelection = selection?.bodyId === target && selection.kind === kind && Number.isInteger(selection.index) && selection.index! >= 0;
    const writeIndices = (indices: number[] | undefined) => {
      if (isFace) update({ faces: indices });
      else update({ edges: indices });
    };
    return <div className="topology-selector">
      <label className="field"><span>{isFace ? 'Caras que se abrirán' : 'Aristas seleccionadas'}</span>
        <input type="text" inputMode="text" value={indicesText} aria-describedby={indicesHelpId}
          aria-invalid={!!indicesError} placeholder={isFace ? 'Automática: cara superior' : 'Todas las aristas'}
          onChange={event => {
            const text = event.currentTarget.value;
            setIndicesText(text);
            if (!text.trim()) { writeIndices(undefined); setIndicesError(''); return; }
            const parts = text.split(',').map(part => part.trim());
            if (parts.some(part => !/^\d+$/.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) < 1)) {
              setIndicesError('Usa números enteros desde 1, separados por comas.');
              return;
            }
            writeIndices([...new Set(parts.map(part => Number(part) - 1))]);
            setIndicesError('');
          }} />
      </label>
      <small className="field-help" id={indicesHelpId}>Selecciona {isFace ? 'una cara' : 'una arista'} en el visor y añádela. También puedes escribir sus números desde 1.</small>
      <div className="button-row">
        <button type="button" className="secondary small" disabled={!matchingSelection}
          onClick={() => {
            if (!matchingSelection) return;
            const indices = [...new Set([...(selectedIndices(draft) ?? []), selection!.index!])];
            writeIndices(indices);
            setIndicesText(indices.map(index => index + 1).join(', '));
            setIndicesError('');
          }}>Añadir selección</button>
        <button type="button" className="secondary small" onClick={() => {
          writeIndices(undefined); setIndicesText(''); setIndicesError('');
        }}>{isFace ? 'Elegir automáticamente' : 'Todas las aristas'}</button>
      </div>
      {indicesError && <p className="editor-error" role="alert">{indicesError}</p>}
    </div>;
  }

  function validateDraft(): string | undefined {
    if (!draft.name.trim()) return 'Escribe un nombre para la operación.';
    if (hasNonfiniteNumber(draft)) return 'Revisa los campos numéricos: todos deben contener números finitos.';
    if (indicesError) return indicesError;
    if (draft.type === 'extrude' && Math.abs(draft.distance) < .001) return 'La extrusión debe medir al menos 0,001 mm.';
    if (draft.type === 'revolve' && Math.abs(draft.angle) < .001) return 'El ángulo de revolución debe ser distinto de cero.';
    if (draft.type === 'boolean' && draft.target === draft.tool) return 'Elige dos cuerpos distintos.';
    if (draft.type === 'pattern') {
      if (!Number.isInteger(draft.count)) return 'El número de repeticiones debe ser entero.';
      if (Math.hypot(...draft.direction) < 1e-9) return 'La dirección del patrón debe ser distinta de cero.';
      if (draft.kind === 'linear' && Math.abs(draft.distance) < .001) return 'La separación del patrón debe ser distinta de cero.';
      if (draft.kind === 'circular' && Math.abs(draft.angle) < .001) return 'El ángulo del patrón debe ser distinto de cero.';
    }
    return undefined;
  }

  return <form key={draft.id} className="feature-editor" aria-label={`Editar ${feature.name}`} aria-busy={busy}
    onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      const invalid = validateDraft();
      if (invalid) { setError(invalid); return; }
      const result: Feature = { ...draft, name: draft.name.trim() };
      if (result.type === 'transform') result.scale = [result.scale[0], result.scale[0], result.scale[0]];
      onApply(result);
    }}>
    <h3>{TITLES[draft.type]}</h3>
    <fieldset className="editor-fields" disabled={busy}>
      <label className="field"><span>Nombre</span>
        <input type="text" value={draft.name} required maxLength={120} onChange={event => update({ name: event.currentTarget.value })} />
      </label>

      {draft.type === 'primitive' && <>
        <label className="field"><span>Forma</span><select aria-label="Forma" value={draft.kind} onChange={event => update({ kind: event.currentTarget.value as 'box' | 'cylinder' | 'sphere' })}>
          <option value="box">Caja</option><option value="cylinder">Cilindro</option><option value="sphere">Esfera</option>
        </select></label>
        {draft.kind === 'box' && <div className="form-grid">
          <NumberField label="Ancho" value={draft.width} min={.001} max={100000} onChange={width => update({ width })} />
          <NumberField label="Fondo" value={draft.depth} min={.001} max={100000} onChange={depth => update({ depth })} />
        </div>}
        {draft.kind !== 'box' && <NumberField label="Radio" value={draft.radius} min={.001} max={100000} onChange={radius => update({ radius })} />}
        {draft.kind !== 'sphere' && <NumberField label="Altura" value={draft.height} min={.001} max={100000} onChange={height => update({ height })} />}
        <VectorFields label="Centro" value={draft.center} onChange={center => update({ center })} />
        {usePickedPoint(center => update({ center }))}
        {modeFields(draft.mode, draft.target)}
      </>}

      {draft.type === 'sketch' && <>
        {planeSelector(draft.plane)}
        <NumberField label="Desplazamiento del plano" value={draft.offset} min={-1_000_000} max={1_000_000} onChange={offset => update({ offset })} />
        <p className="field-help">{draft.entities.length} {draft.entities.length === 1 ? 'figura en el croquis' : 'figuras en el croquis'}.</p>
        {onEditSketch && <button type="button" className="secondary" onClick={() => onEditSketch(draft)}>Editar croquis</button>}
      </>}

      {draft.type === 'extrude' && <>
        {sketchSelector(draft.sketchId)}
        <NumberField label="Distancia" value={draft.distance} min={-100000} max={100000} onChange={distance => update({ distance })} />
        <label className="check-field"><input type="checkbox" style={{ width: 'auto' }} checked={!!draft.symmetric} onChange={event => update({ symmetric: event.currentTarget.checked })} />Simétrica respecto al croquis</label>
        {modeFields(draft.mode, draft.target)}
      </>}

      {draft.type === 'revolve' && <>
        {sketchSelector(draft.sketchId)}
        <NumberField label="Ángulo" value={draft.angle} min={-360} max={360} unit="°" onChange={angle => update({ angle })} />
        <label className="field"><span>Eje de revolución</span><select aria-label="Eje de revolución" value={draft.axis} onChange={event => update({ axis: event.currentTarget.value as 'X' | 'Y' | 'Z' })}>
          {['X', 'Y', 'Z'].map(axis => <option key={axis} value={axis}>{axis}</option>)}
        </select></label>
        <VectorFields label="Origen del eje" value={draft.origin} onChange={origin => update({ origin })} />
        {usePickedPoint(origin => update({ origin }))}
        {modeFields(draft.mode, draft.target)}
      </>}

      {draft.type === 'import' && <p className="field-help">El archivo está vinculado a este cuerpo. Usa Transformar para ajustar su posición, rotación o tamaño.</p>}

      {draft.type === 'transform' && <>
        {bodySelector('Cuerpo', draft.target, updateTarget)}
        <VectorFields label="Desplazamiento" value={draft.translation} onChange={translation => update({ translation })} />
        <VectorFields label="Rotación alrededor del origen" value={draft.rotation} unit="°" onChange={rotation => update({ rotation })} />
        <NumberField label="Escala uniforme" value={draft.scale[0]} min={.001} max={100000} unit="×" onChange={value => update({ scale: [value, value, value] })} />
        <small className="field-help">La escala y la rotación se aplican alrededor del origen global.</small>
      </>}

      {(draft.type === 'fillet' || draft.type === 'chamfer') && <>
        {bodySelector('Cuerpo', draft.target, updateTarget)}
        {draft.type === 'fillet'
          ? <NumberField label="Radio" value={draft.radius} min={.001} max={100000} onChange={radius => update({ radius })} />
          : <NumberField label="Distancia" value={draft.distance} min={.001} max={100000} onChange={distance => update({ distance })} />}
        {topologyFields('edge', draft.target)}
      </>}

      {draft.type === 'shell' && <>
        {bodySelector('Cuerpo', draft.target, updateTarget)}
        <NumberField label="Espesor de pared" value={draft.thickness} min={.001} max={100000} onChange={thickness => update({ thickness })} />
        {topologyFields('face', draft.target)}
      </>}

      {draft.type === 'boolean' && <>
        {bodySelector('Cuerpo de destino', draft.target, updateTarget, draft.tool)}
        {bodySelector('Cuerpo herramienta', draft.tool, tool => update({ tool }), draft.target)}
        <label className="field"><span>Operación</span><select aria-label="Operación" value={draft.operation} onChange={event => update({ operation: event.currentTarget.value as 'add' | 'cut' | 'intersect' })}>
          <option value="add">Unión</option><option value="cut">Diferencia</option><option value="intersect">Intersección</option>
        </select></label>
        <label className="check-field"><input type="checkbox" style={{ width: 'auto' }} checked={!!draft.keepTool} onChange={event => update({ keepTool: event.currentTarget.checked })} />Conservar cuerpo herramienta</label>
      </>}

      {draft.type === 'pattern' && <>
        {bodySelector('Cuerpo', draft.target, updateTarget)}
        <label className="field"><span>Tipo de patrón</span><select aria-label="Tipo de patrón" value={draft.kind} onChange={event => update({ kind: event.currentTarget.value as 'linear' | 'circular' })}>
          <option value="linear">Lineal</option><option value="circular">Circular</option>
        </select></label>
        <NumberField label="Número total de instancias" value={draft.count} min={2} max={64} step={1} unit="" onChange={count => update({ count })} />
        <VectorFields label={draft.kind === 'linear' ? 'Dirección' : 'Dirección del eje'} value={draft.direction} unit="" onChange={direction => update({ direction })} />
        {draft.kind === 'linear'
          ? <NumberField label="Separación entre instancias" value={draft.distance} min={-100000} max={100000} onChange={distance => update({ distance })} />
          : <>
            <NumberField label="Ángulo total" value={draft.angle} min={-360} max={360} unit="°" onChange={angle => update({ angle })} />
            <VectorFields label="Origen del eje" value={draft.origin} onChange={origin => update({ origin })} />
            {usePickedPoint(origin => update({ origin }))}
          </>}
      </>}

      {draft.type === 'mirror' && <>
        {bodySelector('Cuerpo', draft.target, updateTarget)}
        {planeSelector(draft.plane)}
        <NumberField label="Desplazamiento del plano" value={draft.offset} min={-1_000_000} max={1_000_000} onChange={offset => update({ offset })} />
        <label className="check-field"><input type="checkbox" style={{ width: 'auto' }} checked={!!draft.keepOriginal} onChange={event => update({ keepOriginal: event.currentTarget.checked })} />Conservar cuerpo original</label>
      </>}

      <label className="check-field"><input type="checkbox" style={{ width: 'auto' }} checked={!!draft.suppressed} onChange={event => update({ suppressed: event.currentTarget.checked })} />Suprimir operación</label>
    </fieldset>
    {error && <p className="editor-error" role="alert">{error}</p>}
    <div className="editor-actions button-row actions">
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancelar</button>
      <button type="submit" className="primary" disabled={busy}>{busy ? 'Calculando…' : 'Aplicar operación'}</button>
    </div>
  </form>;
}

export default FeatureEditor;
