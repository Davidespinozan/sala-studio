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
 * Cuántas reservas CONFIRMADAS de clases futuras de este horario quedarían
 * ocultas si la regla deja de cubrir su hueco.
 *
 * expandir_clases empata cada clase materializada con un horario ACTIVO por
 * sala + hora + día de la semana. Si el admin desactiva el horario o le cambia
 * sala/hora/días, las clases que ya existen (las que tienen reservas) dejan de
 * encontrarse: desaparecen de la Agenda y de la app, con sus reservas encima.
 * Esto NO cambia la base: solo lee, para frenar el cambio en el formulario.
 */
export async function reservasQueQuedarianOcultas(
  horarioId: string,
  nueva: { activo: boolean; recurso_id: string; hora_inicio: string; dias_semana: number[] }
): Promise<{ total: number; error: string | null }> {
  // Un día de margen hacia atrás: la fecha "de hoy" del gym puede ir detrás de UTC.
  const desde = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const { data: clases, error } = await supabase
    .from('clases')
    .select('id, fecha, hora_inicio, recurso_id, status')
    .eq('horario_recurrente_id', horarioId)
    .gte('fecha', desde)
    .neq('status', 'cancelada');
  if (error) return { total: 0, error: error.message };

  const hhmm = (h: string) => h.slice(0, 5);
  const huerfanas = (clases ?? []).filter((c) => {
    const dow = new Date(`${c.fecha}T12:00:00Z`).getUTCDay();
    const cubierta =
      nueva.activo &&
      c.recurso_id === nueva.recurso_id &&
      hhmm(c.hora_inicio) === hhmm(nueva.hora_inicio) &&
      nueva.dias_semana.includes(dow);
    return !cubierta;
  });
  if (huerfanas.length === 0) return { total: 0, error: null };

  const { count, error: errRes } = await supabase
    .from('reservas')
    .select('id', { count: 'exact', head: true })
    .in('clase_id', huerfanas.map((c) => c.id))
    .eq('status', 'confirmada');
  if (errRes) return { total: 0, error: errRes.message };
  // Sin conteo no se sabe si hay reservas: se bloquea (fail-closed), no se asume 0.
  if (count === null || count === undefined) return { total: 0, error: 'sin conteo de reservas' };
  return { total: count, error: null };
}

/**
 * Elimina la regla de horario recurrente vía RPC (eliminar_horario_recurrente),
 * que en una transacción borra también sus clases de hoy en adelante SIN nada
 * colgado (reservas, lista de espera, invitados). Antes se borraba solo el
 * horario y esas clases (las editadas a mano) quedaban sueltas por la FK
 * ON DELETE SET NULL: seguían saliendo en la Agenda aunque el horario ya no
 * existiera (numa, sábado 6am). Las clases con reservas se conservan.
 */
export async function eliminarHorarioRecurrente(
  id: string
): Promise<{ error: string | null; clasesConservadas: number }> {
  const { data, error } = await supabase.rpc('eliminar_horario_recurrente' as never, {
    p_horario_id: id
  } as never);
  const res = data as { clases_conservadas?: number } | null;
  return { error: error?.message ?? null, clasesConservadas: res?.clases_conservadas ?? 0 };
}

// generarClasesAhora se eliminó con el modelo virtual: las clases ya no se
// pre-generan; se calculan al vuelo (expandir_clases) y se materializan al
// reservar/editar/cancelar. El horario es la única fuente de verdad.
