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

export interface ReportesData {
  rango: { desde: string; hasta: string; dias: number };
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

/** Calcula [desde, hasta] (YYYY-MM-DD) del período, en la tz del tenant. */
function calcularRango(periodo: PeriodoReporte, hoy: string): { desde: string; hasta: string } {
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

/**
 * Reportes básicos (Starter): ocupación, miembros, reservas.
 * S4.4-aware: el rango de fechas se calcula en la timezone del tenant.
 * Agrega en JS — el dataset por período es chico. Para datasets grandes,
 * migrar a un RPC agregado (ver reporte del sprint).
 */
export function useReportes(periodo: PeriodoReporte) {
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const [data, setData] = useState<ReportesData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);

    async function load() {
      const hoy = hoyEnTimezone(tz);
      const { desde, hasta } = calcularRango(periodo, hoy);
      const dias = diasEntre(desde, hasta) + 1;
      // Rango de instantes para filtrar reservas/usuarios por timestamptz.
      const desdeInstante = instanteDeClase(desde, '00:00', tz).toISOString();
      const hastaInstante = instanteDeClase(hasta, '23:59', tz).toISOString();

      const [clasesRes, reservasRes, usuariosRes] = await Promise.all([
        supabase
          .from('clases')
          .select('id, fecha, cupo_max, recurso:recursos(nombre)')
          .eq('tenant_id', tenant.id)
          .neq('status', 'cancelada')
          .gte('fecha', desde)
          .lte('fecha', hasta),
        supabase
          .from('reservas')
          .select('id, status, clase_id')
          .eq('tenant_id', tenant.id)
          .gte('slot_inicio', desdeInstante)
          .lte('slot_inicio', hastaInstante),
        supabase
          .from('usuarios')
          .select('id, status, created_at, membresia_tier')
          .eq('tenant_id', tenant.id)
          .eq('rol', 'miembro')
      ]);

      if (!mounted) return;

      const clases = (clasesRes.data ?? []) as unknown as ClaseRow[];
      const reservas = (reservasRes.data ?? []) as ReservaRow[];
      const usuarios = (usuariosRes.data ?? []) as UsuarioRow[];

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

      // Ocupación por sala
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
      const activos = usuarios.filter((u) => u.status === 'activo').length;
      const bajas = usuarios.filter(
        (u) => u.status === 'cancelado' || u.status === 'suspendido'
      ).length;
      const altasNuevas = usuarios.filter(
        (u) => u.created_at >= desdeInstante && u.created_at <= hastaInstante
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

      // Reservas por día (todos los días del rango, rellenando con 0)
      const countPorFecha = new Map<string, number>();
      for (const r of reservasEnPeriodo) {
        const fecha = claseById.get(r.clase_id!)!.fecha;
        countPorFecha.set(fecha, (countPorFecha.get(fecha) ?? 0) + 1);
      }
      const porDia: { fecha: string; cantidad: number }[] = [];
      for (let i = 0; i < dias; i++) {
        const f = sumarDias(desde, i);
        porDia.push({ fecha: f, cantidad: countPorFecha.get(f) ?? 0 });
      }

      setData({
        rango: { desde, hasta, dias },
        ocupacion: { promedioPct, totalClases: clases.length, asistenciaPct, noShows, porSala },
        miembros: { activos, altasNuevas, bajas, total: usuarios.length, porPlan },
        reservas: {
          total: reservasEnPeriodo.length,
          confirmadas,
          canceladas,
          promedioPorDia: dias > 0 ? Math.round((reservasEnPeriodo.length / dias) * 10) / 10 : 0,
          porDia
        }
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
