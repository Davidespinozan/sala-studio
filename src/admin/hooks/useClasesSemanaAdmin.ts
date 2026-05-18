import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import {
  clasesDelDia,
  type Clase,
  type RecursoMin
} from '@member/logic/claseAdapter';
import { formatDateISO } from '@member/logic/reservaLogic';

/**
 * Admin: clases computadas de los próximos 7 días desde una fecha.
 * NO filtra por tier del usuario (admin ve todas).
 *
 * @param inicioSemana fecha de inicio (lunes a las 00:00) — los 7 días se cuentan
 *   desde acá inclusive.
 * @param salaIdFilter si se provee, solo computa clases de ese recurso.
 */
export function useClasesSemanaAdmin(inicioSemana: Date, salaIdFilter?: string) {
  const tenant = useTenant();
  const [clases, setClases] = useState<Clase[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const duracionDefaultMin = useMemo<number>(() => {
    const c = (tenant.config as Record<string, unknown> | null | undefined)?.reserva as
      | Record<string, unknown>
      | undefined;
    const v = c?.duracion_default_min;
    return typeof v === 'number' && v > 0 ? v : 60;
  }, [tenant.config]);

  // Primitivo estable para deps
  const inicioMs = inicioSemana.getTime();

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const inicio = new Date(inicioMs);
    const fin = new Date(inicioMs + 7 * 24 * 60 * 60 * 1000);

    const [recursosRes, reservasRes] = await Promise.all([
      supabase
        .from('recursos')
        .select('id, nombre, descripcion, foto_url, tipo_contenido, tiers_permitidos, horarios')
        .eq('tenant_id', tenant.id)
        .eq('activo', true),
      supabase
        .from('reservas')
        .select('recurso_id, slot_inicio')
        .eq('tenant_id', tenant.id)
        .in('status', ['confirmada', 'completada'])
        .gte('slot_inicio', inicio.toISOString())
        .lt('slot_inicio', fin.toISOString())
    ]);

    const allRecursos = (recursosRes.data ?? []) as unknown as RecursoMin[];
    const recursos = salaIdFilter
      ? allRecursos.filter((r) => r.id === salaIdFilter)
      : allRecursos;
    const reservas = (reservasRes.data ?? []) as Array<{
      recurso_id: string;
      slot_inicio: string;
    }>;

    const all: Clase[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(inicioMs + i * 24 * 60 * 60 * 1000);
      const fechaISO = formatDateISO(d);
      const inicioDiaMs = d.getTime();
      const finDiaMs = inicioDiaMs + 24 * 60 * 60 * 1000;
      const reservasDelDia = reservas.filter((r) => {
        const ms = new Date(r.slot_inicio).getTime();
        return ms >= inicioDiaMs && ms < finDiaMs;
      });
      all.push(...clasesDelDia(recursos, fechaISO, duracionDefaultMin, reservasDelDia));
    }

    setClases(all);
    setIsLoading(false);
  }, [tenant.id, inicioMs, salaIdFilter, duracionDefaultMin]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { clases, isLoading, refetch };
}
