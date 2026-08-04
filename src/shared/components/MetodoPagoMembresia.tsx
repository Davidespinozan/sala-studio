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
 * Selector para ver y CAMBIAR cómo paga el socio su membresía (efectivo/tarjeta/
 * transferencia/domiciliación/otro). Llama a la RPC `establecer_metodo_pago`
 * (staff-gateada). Es informativo: no cobra ni cambia el plan.
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
    onChanged?.(nuevo || null);
  }

  return (
    <select
      value={local}
      onChange={(e) => void cambiar(e.target.value)}
      disabled={saving}
      onClick={(e) => e.stopPropagation()}
      className="ek-input"
      style={{ fontSize: '13px', padding: '6px 10px', height: 'auto', width: 'auto', maxWidth: '220px' }}
      aria-label="Método de pago de la membresía"
    >
      <option value="">Sin especificar</option>
      {OPCIONES.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  );
}