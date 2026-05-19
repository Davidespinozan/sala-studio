import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

export interface MiembroKPIs {
  asistenciasMes: number;
  totalReservas: number;
  noShows: number;
  cancelaciones: number;
  ultimaVisita: Date | null;
}

/** Agregaciones rápidas para la ficha del miembro.
 *  Hace 5 queries en paralelo (4 counts + 1 max-date).
 *  TODO S10: si performance importa, vista materializada o RPC agregado. */
export function useMiembroKPIs(miembroId: string | undefined) {
  const [kpis, setKpis] = useState<MiembroKPIs | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!miembroId) {
      setKpis(null);
      return;
    }
    setIsLoading(true);

    const inicioMes = new Date();
    inicioMes.setDate(1);
    inicioMes.setHours(0, 0, 0, 0);

    const [asistenciasMes, totalReservas, noShows, cancelaciones, ultimaVisitaRow] =
      await Promise.all([
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', miembroId)
          .eq('status', 'completada')
          .gte('slot_inicio', inicioMes.toISOString()),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', miembroId)
          .in('status', ['confirmada', 'completada']),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', miembroId)
          .eq('status', 'no_show'),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', miembroId)
          .in('status', ['cancelada', 'cancelada_admin']),
        supabase
          .from('reservas')
          .select('slot_inicio')
          .eq('usuario_id', miembroId)
          .eq('status', 'completada')
          .order('slot_inicio', { ascending: false })
          .limit(1)
          .maybeSingle()
      ]);

    setKpis({
      asistenciasMes: asistenciasMes.count ?? 0,
      totalReservas: totalReservas.count ?? 0,
      noShows: noShows.count ?? 0,
      cancelaciones: cancelaciones.count ?? 0,
      ultimaVisita:
        ultimaVisitaRow.data?.slot_inicio
          ? new Date(ultimaVisitaRow.data.slot_inicio as string)
          : null
    });
    setIsLoading(false);
  }, [miembroId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { kpis, isLoading, refetch };
}
