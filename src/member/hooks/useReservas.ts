import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import type { Database } from '@shared/types/database';
import { traducirErrorRPC } from '@member/logic/reservaLogic';

type Reserva = Database['public']['Tables']['reservas']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];

export interface ReservaConRecurso extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre'> | null;
}

/**
 * Lista las reservas del usuario actual, con datos del recurso joineado.
 */
export function useReservasDelUsuario() {
  const { usuario } = useAuth();
  const [reservas, setReservas] = useState<ReservaConRecurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!usuario) {
      setReservas([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const { data, error: queryError } = await supabase
      .from('reservas')
      .select('*, recurso:recursos(id, slug, nombre)')
      .eq('usuario_id', usuario.id)
      .order('slot_inicio', { ascending: false });

    if (queryError) {
      setError(queryError.message);
      setIsLoading(false);
      return;
    }

    setReservas((data ?? []) as unknown as ReservaConRecurso[]);
    setIsLoading(false);
  }, [usuario]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { reservas, isLoading, error, refetch };
}

/**
 * Crea una reserva llamando al RPC atómico.
 *
 * NOTA: la firma del RPC cambió en la migración 160000 (agregó p_duracion_min
 * y renombró p_invitados_count → p_invitados, returns jsonb en vez de reservas).
 * Cast a `any` hasta que se aplique la migración y se regeneren tipos.
 */
export async function crearReserva(params: {
  recursoId: string;
  slotInicio: Date;
  duracionMin: number;
  invitados?: number;
  notas?: string;
}) {
  const { data, error } = await (supabase.rpc as any)('reservar_recurso_atomic', {
    p_recurso_id: params.recursoId,
    p_slot_inicio: params.slotInicio.toISOString(),
    p_duracion_min: params.duracionMin,
    p_invitados: params.invitados ?? 0,
    p_notas: params.notas
  });

  if (error) {
    throw new Error(traducirErrorRPC(error.message));
  }
  return data;
}

/**
 * Cancela una reserva llamando al RPC atómico.
 */
export async function cancelarReserva(params: {
  reserva_id: string;
  motivo?: string;
}): Promise<{ data: Reserva | null; error: string | null }> {
  const { data, error } = await supabase.rpc('cancelar_reserva_atomic', {
    p_reserva_id: params.reserva_id,
    p_motivo: params.motivo
  });

  if (error) {
    return { data: null, error: traducirErrorRPC(error.message) };
  }
  return { data: data as Reserva, error: null };
}

/**
 * Hook para los recursos del tenant actual.
 */
export function useRecursosDelTenant() {
  const tenant = useTenant();
  const [recursos, setRecursos] = useState<Recurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function load() {
      const { data, error } = await supabase
        .from('recursos')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('orden', { ascending: true });

      if (!isMounted) return;
      if (error) {
        console.error('[useRecursosDelTenant]', error);
        setIsLoading(false);
        return;
      }
      setRecursos(data ?? []);
      setIsLoading(false);
    }

    load();
    return () => { isMounted = false; };
  }, [tenant.id]);

  return { recursos, isLoading };
}

/**
 * Lista las reservas activas (confirmadas o completadas) de un recurso
 * en un rango de fechas. Usado para calcular slots disponibles.
 */
export async function fetchReservasDelRecurso(
  recurso_id: string,
  fechaInicio: Date,
  fechaFin: Date
): Promise<Pick<Reserva, 'slot_inicio'>[]> {
  const { data, error } = await supabase
    .from('reservas')
    .select('slot_inicio')
    .eq('recurso_id', recurso_id)
    .in('status', ['confirmada', 'completada'])
    .gte('slot_inicio', fechaInicio.toISOString())
    .lt('slot_inicio', fechaFin.toISOString());

  if (error) {
    console.error('[fetchReservasDelRecurso]', error);
    return [];
  }
  return data ?? [];
}

/**
 * Lista las reservas activas del usuario en un rango. Para validar regla de continuas.
 */
export async function fetchReservasDelUsuario(
  usuario_id: string,
  fechaInicio: Date,
  fechaFin: Date
): Promise<Pick<Reserva, 'slot_inicio'>[]> {
  const { data, error } = await supabase
    .from('reservas')
    .select('slot_inicio')
    .eq('usuario_id', usuario_id)
    .in('status', ['confirmada', 'completada'])
    .gte('slot_inicio', fechaInicio.toISOString())
    .lt('slot_inicio', fechaFin.toISOString());

  if (error) {
    console.error('[fetchReservasDelUsuario]', error);
    return [];
  }
  return data ?? [];
}
