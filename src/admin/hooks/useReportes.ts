import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import {
  getTenantTimezone,
  hoyEnTimezone,
  sumarDias,
  diasEntre,
  instanteDeClase
} from '@shared/lib/timezone';

export type PeriodoReporte = 'semana' | 'mes' | 'ultimos30' | 'ultimos90';

export const PERIODO_OPTIONS: { value: PeriodoReporte; label: string }[] = [
  { value: 'semana', label: 'Esta semana' },
  { value: 'mes', label: 'Este mes' },
  { value: 'ultimos30', label: 'Últimos 30 días' },
  { value: 'ultimos90', label: 'Últimos 90 días' }
];

/** Métricas de un período. Se calcula igual para el período actual y el anterior. */
export interface MetricasPeriodo {
  ocupacion: {
    promedioPct: number;
    totalClases: number;
    asistenciaPct: number | null;
    noShows: number;
    porSala: { sala: string; ocupacionPct: number }[];
  };
  miembros: {
    activos: number;
    altasNuevas: number;
    bajas: number;
    total: number;
    porPlan: { plan: string; cantidad: number }[];
  };
  reservas: {
    total: number;
    confirmadas: number;
    canceladas: number;
    promedioPorDia: number;
    porDia: { fecha: string; cantidad: number }[];
  };
}

export interface ReportesData extends MetricasPeriodo {
  rango: { desde: string; hasta: string; dias: number };
  /**
   * Métricas del período anterior equivalente, para comparación.
   * Solo los KPIs ligados al período (altas, reservas, ocupación, no-shows)
   * son comparables; los snapshots (activos/total/bajas) salen iguales al
   * actual y NO deben compararse desde acá — ver useReportesAvanzados.
   */
  comparacion: MetricasPeriodo | null;
}

export interface RangoReporte {
  desde: string;
  hasta: string;
}

/** Calcula [desde, hasta] (YYYY-MM-DD) del período, en la tz del tenant. */
export function calcularRango(periodo: PeriodoReporte, hoy: string): RangoReporte {
  if (periodo === 'mes') {
    return { desde: `${hoy.slice(0, 7)}-01`, hasta: hoy };
  }
  if (periodo === 'ultimos30') {
    return { desde: sumarDias(hoy, -29), hasta: hoy };
  }
  if (periodo === 'ultimos90') {
    return { desde: sumarDias(hoy, -89), hasta: hoy };
  }
  // semana: lunes de la semana actual
  const [y, m, d] = hoy.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0=dom..6=sab
  const offset = dow === 0 ? -6 : 1 - dow;
  return { desde: sumarDias(hoy, offset), hasta: hoy };
}

/**
 * Calcula el período anterior equivalente, para comparación.
 * - 'mes': el mes calendario pasado COMPLETO (decisión del sprint).
 * - resto: una ventana de igual longitud, inmediatamente anterior.
 */
export function calcularRangoAnterior(
  periodo: PeriodoReporte,
  rangoActual: RangoReporte,
  hoy: string
): RangoReporte {
  if (periodo === 'mes') {
    const [y, m] = hoy.split('-').map(Number);
    const yPrev = m === 1 ? y - 1 : y;
    const mPrev = m === 1 ? 12 : m - 1;
    const ultimo = new Date(y, m - 1, 0); // día 0 del mes actual = último del anterior
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
      desde: `${yPrev}-${pad(mPrev)}-01`,
      hasta: `${ultimo.getFullYear()}-${pad(ultimo.getMonth() + 1)}-${pad(ultimo.getDate())}`
    };
  }
  const dias = diasEntre(rangoActual.desde, rangoActual.hasta) + 1;
  return {
    desde: sumarDias(rangoActual.desde, -dias),
    hasta: sumarDias(rangoActual.desde, -1)
  };
}

interface ClaseRow {
  id: string;
  fecha: string;
  cupo_max: number;
  recurso: { nombre: string } | null;
}
interface ReservaRow {
  id: string;
  status: string;
  clase_id: string | null;
}
interface UsuarioRow {
  id: string;
  status: string;
  created_at: string;
  membresia_tier: string | null;
}

const PLAN_LABEL: Record<string, string> = {
  pro: 'Ilimitado',
  basica: 'Drop-In'
};

interface RangoCompleto {
  desde: string;
  hasta: string;
  dias: number;
  desdeInstante: string;
  hastaInstante: string;
}

/**
 * Agrega las métricas de un período. Función pura: mismas reglas para el
 * período actual y el de comparación.
 */
function agregarMetricas(
  clases: ClaseRow[],
  reservas: ReservaRow[],
  usuarios: UsuarioRow[],
  rango: RangoCompleto
): MetricasPeriodo {
  const claseById = new Map(clases.map((c) => [c.id, c]));

  // Solo reservas cuya clase está en el set (no cancelada, dentro del rango).
  const reservasEnPeriodo = reservas.filter(
    (r) => r.clase_id != null && claseById.has(r.clase_id)
  );

  // ── Bloque 1: ocupación ──
  const activasPorClase = new Map<string, number>();
  for (const r of reservasEnPeriodo) {
    if (r.status === 'confirmada' || r.status === 'completada') {
      activasPorClase.set(r.clase_id!, (activasPorClase.get(r.clase_id!) ?? 0) + 1);
    }
  }
  const ocupaciones = clases.map((c) =>
    c.cupo_max > 0 ? Math.min(1, (activasPorClase.get(c.id) ?? 0) / c.cupo_max) : 0
  );
  const promedioPct =
    ocupaciones.length > 0
      ? Math.round((ocupaciones.reduce((a, b) => a + b, 0) / ocupaciones.length) * 100)
      : 0;

  const completadas = reservasEnPeriodo.filter((r) => r.status === 'completada').length;
  const noShows = reservasEnPeriodo.filter((r) => r.status === 'no_show').length;
  const asistenciaPct =
    completadas + noShows > 0
      ? Math.round((completadas / (completadas + noShows)) * 100)
      : null;

  const salaAgg = new Map<string, { suma: number; n: number }>();
  for (const c of clases) {
    const sala = c.recurso?.nombre ?? '—';
    const oc = c.cupo_max > 0 ? Math.min(1, (activasPorClase.get(c.id) ?? 0) / c.cupo_max) : 0;
    const cur = salaAgg.get(sala) ?? { suma: 0, n: 0 };
    cur.suma += oc;
    cur.n += 1;
    salaAgg.set(sala, cur);
  }
  const porSala = [...salaAgg.entries()]
    .map(([sala, { suma, n }]) => ({
      sala,
      ocupacionPct: n > 0 ? Math.round((suma / n) * 100) : 0
    }))
    .sort((a, b) => b.ocupacionPct - a.ocupacionPct);

  // ── Bloque 2: miembros ──
  // activos/bajas/total son SNAPSHOTS (estado actual de la BD), no dependen
  // del rango. altasNuevas sí es del período.
  const activos = usuarios.filter((u) => u.status === 'activo').length;
  const bajas = usuarios.filter(
    (u) => u.status === 'cancelado' || u.status === 'suspendido'
  ).length;
  const altasNuevas = usuarios.filter(
    (u) => u.created_at >= rango.desdeInstante && u.created_at <= rango.hastaInstante
  ).length;
  const planAgg = new Map<string, number>();
  for (const u of usuarios) {
    const plan = u.membresia_tier
      ? PLAN_LABEL[u.membresia_tier] ?? u.membresia_tier
      : 'Sin plan';
    planAgg.set(plan, (planAgg.get(plan) ?? 0) + 1);
  }
  const porPlan = [...planAgg.entries()]
    .map(([plan, cantidad]) => ({ plan, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad);

  // ── Bloque 3: reservas ──
  const confirmadas = reservasEnPeriodo.filter(
    (r) => r.status === 'confirmada' || r.status === 'completada'
  ).length;
  const canceladas = reservasEnPeriodo.filter((r) => r.status === 'cancelada').length;

  const countPorFecha = new Map<string, number>();
  for (const r of reservasEnPeriodo) {
    const fecha = claseById.get(r.clase_id!)!.fecha;
    countPorFecha.set(fecha, (countPorFecha.get(fecha) ?? 0) + 1);
  }
  const porDia: { fecha: string; cantidad: number }[] = [];
  for (let i = 0; i < rango.dias; i++) {
    const f = sumarDias(rango.desde, i);
    porDia.push({ fecha: f, cantidad: countPorFecha.get(f) ?? 0 });
  }

  return {
    ocupacion: { promedioPct, totalClases: clases.length, asistenciaPct, noShows, porSala },
    miembros: { activos, altasNuevas, bajas, total: usuarios.length, porPlan },
    reservas: {
      total: reservasEnPeriodo.length,
      confirmadas,
      canceladas,
      promedioPorDia:
        rango.dias > 0 ? Math.round((reservasEnPeriodo.length / rango.dias) * 10) / 10 : 0,
      porDia
    }
  };
}

/**
 * Reportes básicos (Starter): ocupación, miembros, reservas + comparación con
 * el período anterior. S4.4-aware: el rango se calcula en la tz del tenant.
 * Agrega en JS — el dataset por período es chico. Para datasets grandes,
 * migrar a un RPC agregado.
 */
export function useReportes(periodo: PeriodoReporte) {
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const [data, setData] = useState<ReportesData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);

    async function fetchDatosRango(rango: RangoReporte) {
      const desdeInstante = instanteDeClase(rango.desde, '00:00', tz).toISOString();
      const hastaInstante = instanteDeClase(rango.hasta, '23:59', tz).toISOString();
      const [clasesRes, reservasRes] = await Promise.all([
        supabase
          .from('clases')
          .select('id, fecha, cupo_max, recurso:recursos(nombre)')
          .eq('tenant_id', tenant.id)
          .neq('status', 'cancelada')
          .gte('fecha', rango.desde)
          .lte('fecha', rango.hasta),
        supabase
          .from('reservas')
          .select('id, status, clase_id')
          .eq('tenant_id', tenant.id)
          .gte('slot_inicio', desdeInstante)
          .lte('slot_inicio', hastaInstante)
      ]);
      return {
        clases: (clasesRes.data ?? []) as unknown as ClaseRow[],
        reservas: (reservasRes.data ?? []) as ReservaRow[],
        desdeInstante,
        hastaInstante
      };
    }

    async function load() {
      const hoy = hoyEnTimezone(tz);
      const rangoActual = calcularRango(periodo, hoy);
      const rangoAnterior = calcularRangoAnterior(periodo, rangoActual, hoy);
      const diasActual = diasEntre(rangoActual.desde, rangoActual.hasta) + 1;
      const diasAnterior = diasEntre(rangoAnterior.desde, rangoAnterior.hasta) + 1;

      const usuariosRes = await supabase
        .from('usuarios')
        .select('id, status, created_at, membresia_tier')
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro');
      const usuarios = (usuariosRes.data ?? []) as UsuarioRow[];

      const [datosAct, datosAnt] = await Promise.all([
        fetchDatosRango(rangoActual),
        fetchDatosRango(rangoAnterior)
      ]);

      if (!mounted) return;

      const metricasActual = agregarMetricas(datosAct.clases, datosAct.reservas, usuarios, {
        ...rangoActual,
        dias: diasActual,
        desdeInstante: datosAct.desdeInstante,
        hastaInstante: datosAct.hastaInstante
      });
      const metricasAnterior = agregarMetricas(datosAnt.clases, datosAnt.reservas, usuarios, {
        ...rangoAnterior,
        dias: diasAnterior,
        desdeInstante: datosAnt.desdeInstante,
        hastaInstante: datosAnt.hastaInstante
      });

      setData({
        ...metricasActual,
        rango: { desde: rangoActual.desde, hasta: rangoActual.hasta, dias: diasActual },
        comparacion: metricasAnterior
      });
      setIsLoading(false);
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [tenant.id, tz, periodo]);

  return { data, isLoading };
}
