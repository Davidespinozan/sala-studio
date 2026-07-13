import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '@admin/providers/SucursalProvider';
import type { Database } from '@shared/types/database';

export type HorarioRecurrente = Database['public']['Tables']['horarios_recurrentes']['Row'];

export interface HorarioRecurrenteFormData {
  recurso_id: string;
  dias_semana: number[];
  hora_inicio: string; // 'HH:MM'
  duracion_minutos: number;
  nombre: string;
  /** Enfoque de la clase ("Piernas + Cardio HIIT"). Lo que la distingue de otra
   *  clase que comparte la misma sala. */
  descripcion: string | null;
  /** Disciplina de ESTA clase. Vacío → la de la sala. */
  disciplina: string | null;
  /** Imagen de ESTA clase. Vacío → la de la sala. */
  foto_url: string | null;
  instructor_id: string | null;
  cupo_max: number | null;
  activo: boolean;
}

/** Horarios recurrentes de la sucursal activa (admin ve activos + inactivos). */
export function useHorariosRecurrentes() {
  const tenant = useTenant();
  const { sucursalId } = useSucursal();
  const [horarios, setHorarios] = useState<HorarioRecurrente[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!sucursalId) {
      setHorarios([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const { data, error } = await supabase
      .from('horarios_recurrentes')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('sucursal_id', sucursalId)
      .order('hora_inicio', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[useHorariosRecurrentes]', error);
      setIsLoading(false);
      return;
    }
    setHorarios(data ?? []);
    setIsLoading(false);
  }, [tenant.id, sucursalId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { horarios, isLoading, refetch };
}

export async function crearHorarioRecurrente(
  tenantId: string,
  sucursalId: string,
  data: HorarioRecurrenteFormData
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('horarios_recurrentes')
    .insert({ tenant_id: tenantId, sucursal_id: sucursalId, ...data });
  return { error: error?.message ?? null };
}

export async function actualizarHorarioRecurrente(
  id: string,
  data: Partial<HorarioRecurrenteFormData>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('horarios_recurrentes').update(data).eq('id', id);
  return { error: error?.message ?? null };
}

/**
 * Aplica la IDENTIDAD de una clase (nombre, enfoque, disciplina, foto) a todas
 * sus franjas horarias.
 *
 * Una clase como "PWR + METCon" puede tener 10 franjas (5am…8pm): son 10 filas
 * de horarios_recurrentes, pero UNA sola clase. Sin esto, cambiarle la foto
 * obligaba a editar las 10 a mano — y bastaba olvidarse de una para que el socio
 * viera dos imágenes distintas de la misma clase.
 *
 * Solo toca lo que define QUÉ es la clase. La hora, los días y el cupo son de
 * cada franja y no se tocan.
 */
export async function aplicarIdentidadAClase(
  tenantId: string,
  recursoId: string,
  nombreActual: string,
  identidad: Pick<HorarioRecurrenteFormData, 'nombre' | 'descripcion' | 'disciplina' | 'foto_url'>
): Promise<{ error: string | null; afectados: number }> {
  const { data, error } = await supabase
    .from('horarios_recurrentes')
    .update(identidad)
    .eq('tenant_id', tenantId)
    .eq('recurso_id', recursoId)
    .eq('nombre', nombreActual)
    .select('id');
  return { error: error?.message ?? null, afectados: data?.length ?? 0 };
}

export async function toggleActivoHorario(
  id: string,
  activo: boolean
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('horarios_recurrentes').update({ activo }).eq('id', id);
  return { error: error?.message ?? null };
}

/**
 * Elimina la regla de horario recurrente. Las clases que ya generó NO se
 * tocan: la FK clases.horario_recurrente_id es ON DELETE SET NULL, así que
 * esas clases (y sus reservas) quedan intactas, solo sin vínculo al horario.
 * Al no existir más, ni "generar ahora" ni el cron crean clases nuevas de él.
 * RLS (horarios_rec_admin_all) limita el DELETE al admin del tenant dueño.
 */
export async function eliminarHorarioRecurrente(
  id: string
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('horarios_recurrentes').delete().eq('id', id);
  return { error: error?.message ?? null };
}

// generarClasesAhora se eliminó con el modelo virtual: las clases ya no se
// pre-generan; se calculan al vuelo (expandir_clases) y se materializan al
// reservar/editar/cancelar. El horario es la única fuente de verdad.
