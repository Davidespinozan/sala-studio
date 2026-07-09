import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';

export interface Pendientes {
  pendientePago: number; // socios que se registraron y no pagaron
  bloqueados: number;    // socios con acceso bloqueado (por no-show) vigente
  noShows7d: number;     // reservas marcadas no-show en los últimos 7 días
}

/**
 * Conteos del "centro de pendientes" del dashboard admin. Consultas baratas
 * (count exact, head) scopeadas al tenant (RLS de admin las filtra igual).
 */
export function usePendientes() {
  const tenant = useTenant();
  const [data, setData] = useState<Pendientes>({ pendientePago: 0, bloqueados: 0, noShows7d: 0 });
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const ahora = new Date().toISOString();
    const hace7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [pago, bloq, ns] = await Promise.all([
      supabase
        .from('usuarios')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro')
        .eq('status', 'pendiente_pago'),
      supabase
        .from('usuarios')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro')
        .gt('bloqueado_hasta', ahora),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'no_show')
        .gte('slot_inicio', hace7d)
    ]);

    setData({
      pendientePago: pago.count ?? 0,
      bloqueados: bloq.count ?? 0,
      noShows7d: ns.count ?? 0
    });
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, isLoading, refetch };
}
