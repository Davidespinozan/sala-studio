import { useState } from 'react';
import { supabase } from '@shared/lib/supabase';

export interface ClasePatch {
  nombre: string;
  descripcion: string | null;
  cupo_max: number;
  duracion_minutos: number;
  instructor_id: string | null;
}

/** S4.3 — mutaciones para editar/cancelar una clase puntual (instancia).
 *  No toca la serie recurrente: solo el row de `clases` con este id. */
export function useEditarCancelarClase(claseId: string) {
  const [updating, setUpdating] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  async function updateClase(patch: ClasePatch): Promise<{ error: string | null }> {
    setUpdating(true);
    // updated_at lo setea el trigger clases_set_updated_at automáticamente.
    const { error } = await supabase
      .from('clases')
      .update(patch)
      .eq('id', claseId);
    setUpdating(false);
    return { error: error?.message ?? null };
  }

  async function cancelarClase(
    motivo = 'Cancelada por admin desde Agenda'
  ): Promise<{ error: string | null }> {
    setCancelling(true);
    const { error } = await supabase
      .from('clases')
      .update({
        status: 'cancelada',
        cancelada_at: new Date().toISOString(),
        cancelada_motivo: motivo
      })
      .eq('id', claseId);
    setCancelling(false);
    return { error: error?.message ?? null };
  }

  return { updateClase, cancelarClase, updating, cancelling };
}
