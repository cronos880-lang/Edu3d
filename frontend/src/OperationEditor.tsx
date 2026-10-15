import { Box, Check, Circle, LocateFixed, Plus, Scissors, Trash2, X } from 'lucide-react';
import type { Operation } from './types';

export type OperationDraft = { index: number | null; mode: Operation['mode']; shape: Operation['shape']; axis: Operation['axis']; parameters: Record<string, string> };
export const operationName = (op: Pick<Operation, 'mode' | 'shape'>) => op.mode === 'cut'
  ? op.shape === 'cylinder' ? 'Taladro' : 'Corte rectangular'
  : op.shape === 'cylinder' ? 'Añadir cilindro' : 'Añadir bloque';
const labels: Record<string, string> = { x: 'Centro X', y: 'Centro Y', z: 'Centro Z', width: 'Ancho', depth: 'Fondo', height: 'Longitud / altura', diameter: 'Diámetro' };

type Props = {
  draft: OperationDraft | null;
  count: number;
  busy: boolean;
  onNew: (mode: Operation['mode'], shape: Operation['shape']) => void;
  onChange: (draft: OperationDraft) => void;
  onApply: () => void;
  onDelete: () => void;
  onCancel: () => void;
  placing: boolean;
  onPlace: () => void;
  operations: Operation[];
  onSelect: (index: number) => void;
};

export default function OperationEditor({ draft, count, busy, onNew, onChange, onApply, onDelete, onCancel, placing, onPlace, operations, onSelect }: Props) {
  return <div className="property-section operations-section">
    <div className="section-title">OPERACIONES NUEVAS <span>{count} / 12</span></div>
    <p className="section-description">Añade detalles editables sobre tu sólido. Los detalles originales del STL aún no tienen parámetros independientes.</p>
    {operations.length > 0 && <div className="operation-mobile-list">{operations.map((operation, index) => <button key={index} onClick={() => onSelect(index)} aria-label={`Editar detalle ${index + 1}: ${operationName(operation)}`} disabled={busy}><span>{operationName(operation)} {index + 1}</span><span>Editar</span></button>)}</div>}
    {!draft ? <>
      <div className="operation-add-grid">
        <button onClick={() => onNew('cut', 'cylinder')} disabled={busy || count >= 12}><Circle size={14} /><span>Taladro</span><Plus size={11} /></button>
        <button onClick={() => onNew('cut', 'box')} disabled={busy || count >= 12}><Scissors size={14} /><span>Corte rectangular</span><Plus size={11} /></button>
        <button onClick={() => onNew('add', 'cylinder')} disabled={busy || count >= 12}><Circle size={14} /><span>Añadir cilindro</span><Plus size={11} /></button>
        <button onClick={() => onNew('add', 'box')} disabled={busy || count >= 12}><Box size={14} /><span>Añadir bloque</span><Plus size={11} /></button>
      </div>
      {count >= 12 && <p className="operation-limit">Máximo de 12 operaciones por pieza. Edita o elimina una operación existente para continuar.</p>}
    </> : <form className="operation-editor" onSubmit={event => { event.preventDefault(); onApply(); }}>
      <div className="operation-editor-heading"><strong>{draft.index === null ? 'Nueva operación' : `Editar operación ${draft.index + 1}`}</strong><button type="button" onClick={onCancel} aria-label="Cerrar editor de operación"><X size={14} /></button></div>
      <div className="operation-kind-label">{draft.mode === 'cut' ? <Scissors size={13} /> : <Plus size={13} />}{operationName(draft)}</div>
      <button className={`place-operation-button ${placing ? 'active' : ''}`} type="button" onClick={onPlace} disabled={busy}><LocateFixed size={14} />{placing ? 'Selecciona un punto de la pieza…' : 'Situar en pieza'}</button>
      {draft.shape === 'cylinder' && <div className="operation-axis" role="group" aria-label="Eje del cilindro"><span>Eje del cilindro</span><div className="axis-selector">{(['x', 'y', 'z'] as const).map(axis => <button type="button" key={axis} className={draft.axis === axis ? 'active' : ''} onClick={() => onChange({ ...draft, axis })} disabled={busy} aria-pressed={draft.axis === axis}>{axis.toUpperCase()}</button>)}</div></div>}
      <div className="operation-fields">{Object.entries(draft.parameters).map(([key, value]) => <label className={`parameter-field ${['x', 'y', 'z'].includes(key) ? 'coordinate-field' : ''}`} key={key}><span>{labels[key] || key}</span><div className="number-input"><input type="number" step="any" min={['x', 'y', 'z'].includes(key) ? undefined : 0.001} value={value} onChange={event => onChange({ ...draft, parameters: { ...draft.parameters, [key]: event.target.value } })} aria-label={`${labels[key] || key} de operación en milímetros`} disabled={busy} /><span className="input-unit">mm</span></div></label>)}</div>
      <p className="operation-position-note">Centro en coordenadas globales, en mm. {draft.mode === 'cut' ? 'Coloca el corte donde atraviese material de la pieza.' : 'El nuevo volumen debe tocar la pieza para formar un único sólido.'}</p>
      <button className="button primary apply-button" type="submit" disabled={busy}><Check size={14} />{draft.index === null ? 'Aplicar operación' : 'Guardar operación'}</button>
      {draft.index !== null && <button type="button" className="delete-operation-button" onClick={onDelete} disabled={busy}><Trash2 size={13} /> Eliminar operación</button>}
      <button className="discard-button" type="button" onClick={onCancel} disabled={busy}>Cancelar edición</button>
    </form>}
  </div>;
}
