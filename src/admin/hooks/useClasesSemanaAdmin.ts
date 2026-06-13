import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '@admin/providers/SucursalProvider';
import {
  claseFromExpansion,
  type Clase,
  type ClaseExpansionRow
} from '@member/logic/claseAdapter';
import { getSucursalTimezone, getTenantTimezone } from '@shared/lib/timezone';

/**
 * Admin: clases de los próximos 7 días de una sucursal, calculadas al vuelo con
 * expandir_clases (modelo virtual: reglas + materializadas con overrides). Una
 * sola RPC trae las clases con cupos; ya no se pre-generan.
 *
 * @param inicioSemana fecha de inicio (lunes 00:00). 7 días inclusive.
 * @param salaIdFilter si se provee, solo trae clases de ese recurso.
 */
export function useClasesSemanaAdmin(inicioSemana: Date, salaIdFilter?: string) {
  const tenant = useTenant();
  const { sucursalId, sucursalActiva } = useSucursal();
  const [clases, setClases] = useState<Clase[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const inicioMs = inicioSemana.getTime();

  // Agenda scopeada a una sola sucursal → todas comparten su tz (fallback tenant).
  const tz = getSucursalTimezone(sucursalActiva?.timezone, getTenantTimezone(tenant));

  const refetch = useCallback(async () => {
    if (!sucursalId) {
      setClases([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const desdeISO = ymd(new Date(inicioMs));
    const hastaISO = ymd(new Date(inicioMs + 6 * 24 * 60 * 60 * 1000)); // inclusivo

    const rpc = supabase.rpc as unknown as (
      name: string, args: Record<string, unknown>
    ) => Promise<{ data: ClaseExpansionRow[] | null; error: { message: string } | null }>;
    const { data, error } = await rpc('expandir_clases', {
      p_sucursal_id: sucursalId, p_desde: desdeISO, p_hasta: hastaISO
    });
    if (error) {
      console.error('[useClasesSemanaAdmin:expandir_clases]', error);
      setClases([]);
      setIsLoading(false);
      return;
    }

    let rows = (data ?? []) as ClaseExpansionRow[];
    if (salaIdFilter) rows = rows.filter((r) => r.recurso_id === salaIdFilter);

    const mapped = rows
      .map((r) => claseFromExpansion(r, tz))
      .sort((a, b) => a.slotInicio.getTime() - b.slotInicio.getTime());

    setClases(mapped);
    setIsLoading(false);
  }, [sucursalId, inicioMs, salaIdFilter, tz]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { clases, isLoading, refetch };
}

/** YYYY-MM-DD en tz local (sin desfases por toISOString). */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
