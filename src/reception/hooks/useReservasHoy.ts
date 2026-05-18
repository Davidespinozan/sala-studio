import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import type { Database } from '@shared/types/database';

type Reserva = Database['public']['Tables']['reservas']['Row'];
type Usuario = Database['public']['Tables']['usuarios']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];

export interface ReservaConJoin extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre'> | null;
  usuario: Pick<Usuario, 'id' | 'nombre' | 'email' | 'membresia_tier'> | null;
}

/**
 * Reservas de un día específico (default hoy) del tenant, ordenadas por hora.
 * Polling cada 30s.
 */
export function useReservasHoy(fecha?: Date) {
  const tenant = useTenant();
  const [reservas, setReservas] = useState<ReservaConJoin[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Normalizar fecha a inicio del día (memoizar para evitar re-render infinito)
  const fechaMs = (fecha ?? new Date()).setHours(0, 0, 0, 0);

  const refetch = useCallback(async () => {
    const inicio = new Date(fechaMs);
    const fin = new Date(fechaMs);
    fin.setDate(fin.getDate() + 1);

    const { data, error } = await supabase
      .from('reservas')
      .select('*, recurso:recursos(id, slug, nombre), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)')
      .eq('tenant_id', tenant.id)
      .gte('slot_inicio', inicio.toISOString())
      .lt('slot_inicio', fin.toISOString())
      .order('slot_inicio', { ascending: true });

    if (error) {
      console.error('[useReservasHoy]', error);
      setIsLoading(false);
      return;
    }
    setReservas((data ?? []) as unknown as ReservaConJoin[]);
    setIsLoading(false);
  }, [tenant.id, fechaMs]);

  useEffect(() => {
    refetch();
    const interval = setInterval(refetch, 30_000);
    return () => clearInterval(interval);
  }, [refetch]);

  return { reservas, isLoading, refetch };
}

export async function checkInManual(reservaId: string, motivo?: string) {
  const { data, error } = await supabase.rpc('check_in_manual_atomic', {
    p_reserva_id: reservaId,
    p_motivo: motivo ?? undefined
  });

  if (error) {
    const code = error.message.match(/_[A-Z_]+/)?.[0] ?? 'ERROR';
    throw new Error(translateError(code, error.message));
  }
  return data;
}

function translateError(code: string, fallback: string): string {
  const map: Record<string, string> = {
    RESERVA_NO_EXISTE: 'No encontramos esa reserva',
    YA_CHECK_IN: 'Este miembro ya hizo check-in',
    RESERVA_CANCELADA: 'Esta reserva está cancelada',
    RESERVA_NO_SHOW: 'Esta reserva quedó marcada como inasistencia',
    DEMASIADO_TEMPRANO: 'Todavía es muy temprano para el check-in',
    DEMASIADO_TARDE: 'El check-in ya cerró',
    NO_AUTORIZADO: 'No tenés permiso para hacer esta acción'
  };
  return map[code] ?? fallback.replace(code + ':', '').trim();
}
