import { useState } from 'react';

// Valor sentinela para la opción "Otro" en el <select> (no es un motivo real).
const OTRO = '__otro__';

interface Props {
  /** Motivo actual (controlado). El padre lo usa para gatear Confirmar. */
  value: string;
  /** Emite el motivo resuelto (opción predefinida elegida o texto libre). */
  onChange: (motivo: string) => void;
  /** Motivos predefinidos (NO incluyas "Otro", se agrega solo). */
  opciones: string[];
  label?: string;
  idPrefix?: string;
}

/**
 * Campo controlado de "Motivo" para acciones sensibles de recepción. Select de
 * motivos predefinidos + "Otro" con texto libre. El motivo RESUELTO siempre vive
 * en el `value` controlado del padre; este componente nunca lo pisa salvo por
 * input del usuario.
 *
 * `sel` (posición visible del dropdown) es el único estado interno: hace falta
 * para distinguir "Otro recién elegido, texto aún vacío" de "nada elegido",
 * porque ambos casos dan value === '' y no se pueden derivar solo del value.
 */
export function MotivoField({ value, onChange, opciones, label = 'Motivo del cambio', idPrefix = 'motivo' }: Props) {
  const [sel, setSel] = useState<string>(() =>
    opciones.includes(value) ? value : value ? OTRO : ''
  );

  function handleSelect(next: string) {
    setSel(next);
    // "Otro" y placeholder resuelven a '' (motivo vacío → el padre no deja confirmar).
    onChange(next === OTRO || next === '' ? '' : next);
  }

  return (
    <div className="ek-form-field" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <label className="ek-label" htmlFor={`${idPrefix}-sel`}>{label}</label>
      <select
        id={`${idPrefix}-sel`}
        className="ek-input"
        value={sel}
        onChange={(e) => handleSelect(e.target.value)}
      >
        <option value="" disabled>Elige un motivo…</option>
        {opciones.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
        <option value={OTRO}>Otro (escribir)</option>
      </select>

      {sel === OTRO && (
        <input
          id={`${idPrefix}-libre`}
          className="ek-input"
          type="text"
          placeholder="Escribe el motivo"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
          autoComplete="off"
        />
      )}
    </div>
  );
}
