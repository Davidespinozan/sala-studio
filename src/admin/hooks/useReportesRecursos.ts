import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '../providers/SucursalProvider';

/**
 * Rendimiento por SALA y por INSTRUCTOR (últimos 90 días): qué recurso/profe
 * llena clases y mantiene la asistencia. Reservas + ocupación + asistencia +
 * no-shows agrupadas. Sin Stripe.
 *
 * Lee clases materializadas + sus reservas (solo las clases con reserva están
 * materializadas, así que esto refleja la actividad real).
 */
export interface RendimientoFila {
  nombre: string;
  clases: number;
  reservas: number;
  ocupacionPct: number;
  asistenciaPct: number | null; // completadas / (completadas + no_shows)
  noShows: number;
}
export interface ReportesRecursosData {
  porSala: RendimientoFila[];
  porInstructor: RendimientoFila[];
}

const DIA_MS = 86_400_000;
const VENTANA_DIAS = 90;

interface ClaseRow {
  id: string;
  cupo_max: number;
  recurso: { nombre: string } | null;
  instructor: { nombre: string } | null;
}
interface ReservaRow {
  clase_id: string | null;
  status: string;
}

interface Acc {
  clases: Set<string>;
  reservas: number;
  completadas: number;
  noShows: number;
  ocSum: number;
  ocN: number;
}

function accFor(map: Map<string, Acc>, nombre: string): Acc {
  let a = map.get(nombre);
  if (!a) {
    a = { clases: new Set(), reservas: 0, completadas: 0, noShows: 0, ocSum: 0, ocN: 0 };
    map.set(nombre, a);
  }
  return a;
}

function aFilas(map: Map<string, Acc>): RendimientoFila[] {
  return [...map.entries()]
    .map(([nombre, a]) => {
      const jugadas = a.completadas + a.noShows;
      return {
        nombre,
        clases: a.clases.size,
        reservas: a.reservas,
        ocupacionPct: a.ocN > 0 ? Math.round((a.ocSum / a.ocN) * 100) : 0,
        asistenciaPct: jugadas > 0 ? Math.round((a.completadas / jugadas) * 100) : null,
        noShows: a.noShows
      };
    })
    .sort((x, y) => y.reservas - x.reservas)
    .slice(0, 12);
}

export function useReportesRecursos() {
  const tenant = useTenant();
  const { sucursalFiltro } = useSucursal();
  const [data, setData] = useState<ReportesRecursosData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);

    async function load() {
      const ahora = Date.now();
      const hace90ISO = new Date(ahora - VENTANA_DIAS * DIA_MS).toISOString();
      const hace90Fecha = hace90ISO.slice(0, 10);

      let clasesQ = supabase
        .from('clases')
        .select('id, cupo_max, recurso:recursos(nombre), instructor:instructores(nombre)')
        .eq('tenant_id', tenant.id)
        .neq('status', 'cancelada')
        .gte('fecha', hace90Fecha);
      // Con las clases ya scopeadas por sede, las reservas de otras sedes se
      // descartan solas: la agregación las busca por claseById.
      if (sucursalFiltro) clasesQ = clasesQ.eq('sucursal_id', sucursalFiltro);

      const [clasesRes, reservasRes] = await Promise.all([
        clasesQ,
        supabase
          .from('reservas')
          .select('clase_id, status')
          .eq('tenant_id', tenant.id)
          .gte('slot_inicio', hace90ISO)
      ]);

      if (!mounted) return;

      const clases = (clasesRes.data ?? []) as unknown as ClaseRow[];
      const reservas = (reservasRes.data ?? []) as ReservaRow[];

      const claseById = new Map(clases.map((c) => [c.id, c]));
      const salaMap = new Map<string, Acc>();
      const instMap = new Map<string, Acc>();
      const activasPorClase = new Map<string, number>();

      // Pass 1: reservas → conteos por grupo + activas por clase (para ocupación).
      for (const r of reservas) {
        if (!r.clase_id) continue;
        const c = claseById.get(r.clase_id);
        if (!c) continue;
        const sala = c.recurso?.nombre ?? '—';
        const inst = c.instructor?.nombre ?? 'Sin asignar';
        const aS = accFor(salaMap, sala);
        const aI = accFor(instMap, inst);
        const activa = r.status === 'confirmada' || r.status === 'completada';
        if (activa) {
          aS.reservas++;
          aI.reservas++;
          activasPorClase.set(r.clase_id, (activasPorClase.get(r.clase_id) ?? 0) + 1);
        }
        if (r.status === 'completada') {
          aS.completadas++;
          aI.completadas++;
        }
        if (r.status === 'no_show') {
          aS.noShows++;
          aI.noShows++;
        }
      }

      // Pass 2: clases → ocupación + conteo de clases por grupo.
      for (const c of clases) {
        const oc = c.cupo_max > 0 ? Math.min(1, (activasPorClase.get(c.id) ?? 0) / c.cupo_max) : 0;
        const sala = c.recurso?.nombre ?? '—';
        const inst = c.instructor?.nombre ?? 'Sin asignar';
        const aS = accFor(salaMap, sala);
        const aI = accFor(instMap, inst);
        aS.clases.add(c.id);
        aS.ocSum += oc;
        aS.ocN++;
        aI.clases.add(c.id);
        aI.ocSum += oc;
        aI.ocN++;
      }

      setData({ porSala: aFilas(salaMap), porInstructor: aFilas(instMap) });
      setIsLoading(false);
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [tenant.id, sucursalFiltro]);

  return { data, isLoading };
}
