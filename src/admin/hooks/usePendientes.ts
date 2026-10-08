import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';

export interface Pendientes {
  pendientePago: number; // socios que se registraron y no pagaron
  bloqueados: number;    // socios con acceso bloqueado (por no-show) vigente
  noShows7d: number;     // reservas marcadas no-show en los últimos 7 días
  porCobrar: number;     // cargos "Por cobrar" (plan/pase activado "pagar al llegar")
  porCobrarCentavos: number;
}

const VACIO: Pendientes = { pendientePago: 0, bloqueados: 0, noShows7d: 0, porCobrar: 0, porCobrarCentavos: 0 };

/**
 * Conteos del "centro de pendientes" (dashboard admin y Hoy de recepción).
 * Consultas baratas scopeadas al tenant (RLS de staff las filtra igual).
 * `sucursalId` (recepción multisede) → solo socios/cargos de esa sede, para que
 * el número coincida con lo que muestra la lista filtrada de Socios.
 */
export function usePendientes(sucursalId: string | null = null) {
  const tenant = useTenant();
  const [data, setData] = useState<Pendientes>(VACIO);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const ahora = new Date().toISOString();
    const hace7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    let qPago = supabase
      .from('usuarios')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('rol', 'miembro')
      .eq('status', 'pendiente_pago');
    let qBloq = supabase
      .from('usuarios')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('rol', 'miembro')
      .gt('bloqueado_hasta', ahora);
    if (sucursalId) {
      qPago = qPago.eq('sucursal_id', sucursalId);
      qBloq = qBloq.eq('sucursal_id', sucursalId);
    }

    // cargos_pendientes aún no está en los tipos generados → cast del builder.
    type CargoBuilder = PromiseLike<{ data: { monto_centavos: number }[] | null }> & {
      eq: (c: string, v: unknown) => CargoBuilder;
    };
    let qCargos = (supabase.from as unknown as (t: string) => { select: (s: string) => CargoBuilder })(
      'cargos_pendientes'
    )
      .select('monto_centavos')
      .eq('tenant_id', tenant.id)
      .eq('estado', 'pendiente');
    if (sucursalId) qCargos = qCargos.eq('sucursal_id', sucursalId);

    const [pago, bloq, ns, cargos] = await Promise.all([
      qPago,
      qBloq,
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'no_show')
        .gte('slot_inicio', hace7d),
      qCargos
    ]);

    const filasCargos = cargos.data ?? [];
    setData({
      pendientePago: pago.count ?? 0,
      bloqueados: bloq.count ?? 0,
      noShows7d: ns.count ?? 0,
      porCobrar: filasCargos.length,
      porCobrarCentavos: filasCargos.reduce((s, c) => s + c.monto_centavos, 0)
    });
    setIsLoading(false);
  }, [tenant.id, sucursalId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, isLoading, refetch };
}
