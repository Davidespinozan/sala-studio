import { useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';

/** Etiquetas de los métodos de pago de la membresía (coinciden con el CHECK). */
export const METODO_PAGO_LABEL: Record<string, string> = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  domiciliacion: 'Domiciliación',
  otro: 'Otro'
};

const OPCIONES = Object.entries(METODO_PAGO_LABEL);

/**
 * "Suele pagar con": cómo paga el socio su membresía. Es un dato INFORMATIVO
 * que se llena solo con cada cobro; editarlo es raro (domiciliación, corregir
 * un registro). Por eso se muestra como texto y el selector solo aparece al
 * picar "Cambiar" — un dropdown siempre editable parecía un control de cobro.
 * Guarda vía RPC `establecer_metodo_pago` (staff-gateada); no mueve dinero.
 */
export function MetodoPagoMembresia({
  usuarioId,
  valor,
  onChanged
}: {
  usuarioId: string;
  valor: string | null;
  onChanged?: (nuevo: string | null) => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState<string>(valor ?? '');

  async function cambiar(nuevo: string) {
    const prev = local;
    setLocal(nuevo);
    setSaving(true);
    const rpc = supabase.rpc.bind(supabase) as unknown as (
      name: string,
      args: unknown
    ) => Promise<{ error: { message: string } | null }>;
    const { error } = await rpc('establecer_metodo_pago', {
      p_usuario_id: usuarioId,
      p_metodo: nuevo || null
    });
    setSaving(false);
    if (error) {
      setLocal(prev);
      toast.error('No se pudo cambiar el método de pago.');
      return;
    }
    toast.success('Método de pago actualizado.');
    setEditing(false);
    onChanged?.(nuevo || null);
  }

  if (!editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
        <span style={{ fontWeight: 600, color: 'var(--sala-text-primary)' }}>
          {local ? (METODO_PAGO_LABEL[local] ?? local) : 'Sin registrar'}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setEditing(true); }}
          style={{
            border: 'none',
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--sala-primary)',
            textDecoration: 'underline'
          }}
        >
          Cambiar
        </button>
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
      <select
        value={local}
        onChange={(e) => void cambiar(e.target.value)}
        disabled={saving}
        onClick={(e) => e.stopPropagation()}
        className="ek-input"
        style={{ fontSize: '13px', padding: '6px 10px', height: 'auto', width: 'auto', maxWidth: '220px' }}
        aria-label="Cómo suele pagar su membresía"
        autoFocus
      >
        <option value="">Sin registrar</option>
        {OPCIONES.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setEditing(false); }}
        disabled={saving}
        style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontSize: '12px', color: 'var(--sala-text-tertiary)' }}
      >
        Cancelar
      </button>
    </span>
  );
}