import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import {
  claseFromRow,
  type Clase,
  type RecursoContext,
  type InstructorContext
} from '@member/logic/claseAdapter';
import { getTenantTimezone } from '@shared/lib/timezone';
import type { Database } from '@shared/types/database';

type ClaseRow = Database['public']['Tables']['clases']['Row'];
type RecursoRow = Pick<
  Database['public']['Tables']['recursos']['Row'],
  'id' | 'nombre' | 'foto_url' | 'tiers_permitidos'
>;

interface JoinedClaseRow extends ClaseRow {
  recurso: RecursoRow | null;
  instructor: InstructorContext | null;
}

/**
 * Admin: clases de los próximos 7 días desde una fecha, leyendo de la tabla
 * `clases` real (S4.2). El count de cupos reservados se calcula en una segunda
 * query — Supabase REST no soporta count agregado en el mismo SELECT.
 *
 * @param inicioSemana fecha de inicio (lunes a las 00:00). Los 7 días se cuentan
 *   desde acá inclusive (lunes a domingo).
 * @param salaIdFilter si se provee, solo trae clases de ese recurso.
 */
export function useClasesSemanaAdmin(inicioSemana: Date, salaIdFilter?: string) {
  const tenant = useTenant();
  const [clases, setClases] = useState<Clase[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const inicioMs = inicioSemana.getTime();

  const tz = getTenantTimezone(tenant);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const inicio = new Date(inicioMs);
    const fin = new Date(inicioMs + 7 * 24 * 60 * 60 * 1000);
    const fechaInicioISO = ymd(inicio);
    const fechaFinISO = ymd(fin);

    // S4.3: incluye canceladas para mostrarlas con estilo apagado en la grilla.
    let claseQuery = supabase
      .from('clases')
      .select(
        '*, recurso:recursos(id, nombre, foto_url, tiers_permitidos), instructor:instructores(id, nombre, foto_url)'
      )
      .eq('tenant_id', tenant.id)
      .in('status', ['programada', 'cancelada'])
      .gte('fecha', fechaInicioISO)
      .lt('fecha', fechaFinISO)
      .order('fecha', { ascending: true })
      .order('hora_inicio', { ascending: true });

    if (salaIdFilter) claseQuery = claseQuery.eq('recurso_id', salaIdFilter);

    const { data: clasesRaw, error: clasesErr } = await claseQuery;
    if (clasesErr) {
      console.error('[useClasesSemanaAdmin:clases]', clasesErr);
      setClases([]);
      setIsLoading(false);
      return;
    }

    const filas = (clasesRaw ?? []) as JoinedClaseRow[];
    if (filas.length === 0) {
      setClases([]);
      setIsLoading(false);
      return;
    }

    // Cupos por clase: una sola query agrupada por clase_id
    const claseIds = filas.map((c) => c.id);
    const { data: reservasRaw } = await supabase
      .from('reservas')
      .select('clase_id')
      .in('clase_id', claseIds)
      .in('status', ['confirmada', 'completada']);

    const cuposPorClase = new Map<string, number>();
    for (const r of (reservasRaw ?? []) as Array<{ clase_id: string | null }>) {
      if (!r.clase_id) continue;
      cuposPorClase.set(r.clase_id, (cuposPorClase.get(r.clase_id) ?? 0) + 1);
    }

    const mapped: Clase[] = filas.map((row) => {
      const recurso: RecursoContext = row.recurso
        ? {
            id: row.recurso.id,
            nombre: row.recurso.nombre,
            foto_url: row.recurso.foto_url,
            tiers_permitidos: row.recurso.tiers_permitidos
          }
        : { id: row.recurso_id, nombre: '—' };
      return claseFromRow({
        row,
        cuposReservados: cuposPorClase.get(row.id) ?? 0,
        recurso,
        instructor: row.instructor,
        tz
      });
    });

    setClases(mapped);
    setIsLoading(false);
  }, [tenant.id, inicioMs, salaIdFilter, tz]);

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
