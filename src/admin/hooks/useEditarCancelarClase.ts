import { useState } from 'react';
import { supabase } from '@shared/lib/supabase';

export interface ClasePatch {
  nombre: string;
  descripcion: string | null;
  cupo_max: number;
  duracion_minutos: number;
  instructor_id: string | null;
}

/** Referencia a una clase: materializada (claseId) o virtual (horarioId+fecha). */
export interface ClaseRef {
  claseId: string | null;
  horarioId: string | null;
  fechaISO: string;
}

/** Mutaciones para editar/cancelar UNA instancia de clase. Modelo virtual: si la
 *  clase es virtual (sin claseId), los RPCs la materializan al vuelo. Cancelar
 *  además devuelve créditos y notifica a las reservas (cancelar_clase). Editar un
 *  día puntual no toca la regla (editar_clase_override → recurrente_modificada). */
export function useEditarCancelarClase(ref: ClaseRef) {
  const [updating, setUpdating] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // cancelar_clase / editar_clase_override no están en los tipos generados → cast.
  const rpc = supabase.rpc as unknown as (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  // clase_id si está materializada; si no, (horario_id, fecha).
  const idArgs = ref.claseId
    ? { p_clase_id: ref.claseId, p_horario_id: null, p_fecha: null }
    : { p_clase_id: null, p_horario_id: ref.horarioId, p_fecha: ref.fechaISO };

  async function updateClase(patch: ClasePatch): Promise<{ error: string | null }> {
    setUpdating(true);
    const { error } = await rpc('editar_clase_override', {
      ...idArgs,
      p_nombre: patch.nombre,
      p_descripcion: patch.descripcion,
      p_cupo_max: patch.cupo_max,
      p_duracion_minutos: patch.duracion_minutos,
      p_instructor_id: patch.instructor_id,
      p_motivo: null
    });
    setUpdating(false);
    return { error: error?.message ?? null };
  }

  async function cancelarClase(
    motivo = 'Cancelada por el gimnasio'
  ): Promise<{ error: string | null }> {
    setCancelling(true);
    const { error } = await rpc('cancelar_clase', { ...idArgs, p_motivo: motivo });
    setCancelling(false);
    return { error: error?.message ?? null };
  }

  return { updateClase, cancelarClase, updating, cancelling };
}
