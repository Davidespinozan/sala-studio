import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '../providers/SucursalProvider';
import { getTenantTimezone, hoyEnTimezone, instanteDeClase } from '@shared/lib/timezone';
import {
  calcularRango,
  calcularRangoAnterior,
  type PeriodoReporte,
  type RangoReporte
} from './useReportes';

// Un miembro activo que no reserva/asiste hace este número de días está "en riesgo".
const RIESGO_UMBRAL_DIAS = 21;
// Ventana de reservas que traemos para detectar actividad reciente. Acota el
// payload: quien no aparezca acá simplemente está "sin actividad reciente".
const RIESGO_LOOKBACK_DIAS = 90;
const DIA_MS = 24 * 60 * 60 * 1000;

export interface CohorteRetencion {
  mes: string; // 'YYYY-MM'
  label: string; // 'ene 2026'
  tamano: number;
  /** Retención % a [+1, +2, +3] meses del alta. null = cohorte aún muy joven. */
  retencion: (number | null)[];
}

export interface MiembroRiesgo {
  id: string;
  nombre: string;
  email: string;
  ultimaActividad: string | null; // ISO; null = sin reservas en la ventana
  diasSinActividad: number | null;
}

export interface ReportesAvanzadosData {
  churn: {
    bajas: number;
    bajasAnterior: number;
    activosInicio: number;
    tasaChurnPct: number | null;
    tasaChurnPctAnterior: number | null;
  };
  miembrosActivos: {
    actual: number;
    anterior: number;
  };
  cohortes: CohorteRetencion[];
  retencion3m: { pct: number | null; tamanoCohorte: number; label: string };
  miembrosRiesgo: MiembroRiesgo[];
}

interface HistorialRow {
  usuario_id: string;
  status_nuevo: string;
  changed_at: string;
}
interface MiembroRow {
  id: string;
  nombre: string | null;
  email: string;
  created_at: string;
  status: string;
}

/** Suma k meses a un 'YYYY-MM'. */
function sumarMeses(ym: string, k: number): string {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + k;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Etiqueta legible de un 'YYYY-MM'. */
function labelMes(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('es-MX', {
    month: 'short',
    year: 'numeric'
  });
}

/**
 * Status del usuario en una fecha dada, reconstruido del historial.
 * `entries` debe venir ordenado ascendente por changed_at.
 * Devuelve null si el usuario aún no existía en esa fecha.
 */
function statusEnFecha(entries: HistorialRow[], fechaISO: string): string | null {
  let resultado: string | null = null;
  for (const e of entries) {
    if (e.changed_at <= fechaISO) resultado = e.status_nuevo;
    else break;
  }
  return resultado;
}

/**
 * Reportes avanzados (Pro): churn, retención por cohorte y miembros en riesgo.
 *
 * Performance: agregación en JS, consistente con los reportes básicos. El
 * historial de status es chico (append-only, pocas filas por miembro) y la
 * ventana de reservas está acotada a RIESGO_LOOKBACK_DIAS. Para tenants con
 * miles de miembros conviene migrar cohortes/riesgo a RPCs con window
 * functions; ver reporte del sprint.
 */
export function useReportesAvanzados(periodo: PeriodoReporte) {
  const tenant = useTenant();
  const { sucursalFiltro } = useSucursal();
  const tz = getTenantTimezone(tenant);
  const [data, setData] = useState<ReportesAvanzadosData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);

    async function load() {
      const hoy = hoyEnTimezone(tz);
      const nowISO = new Date().toISOString();
      const rangoActual = calcularRango(periodo, hoy);
      const rangoAnterior = calcularRangoAnterior(periodo, rangoActual, hoy);
      const riesgoDesdeISO = new Date(Date.now() - RIESGO_LOOKBACK_DIAS * DIA_MS).toISOString();

      let miembrosQ = supabase
        .from('usuarios')
        .select('id, nombre, email, created_at, status')
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro');
      if (sucursalFiltro) miembrosQ = miembrosQ.eq('sucursal_id', sucursalFiltro);

      // El historial no tiene sede, pero solo se consulta para socios de
      // `miembros` (ya filtrados), así que queda scopeado de forma natural.
      const reservasQ = sucursalFiltro
        ? supabase
            .from('reservas')
            .select('usuario_id, slot_inicio, recurso:recursos!inner(sucursal_id)')
            .eq('tenant_id', tenant.id)
            .eq('recurso.sucursal_id', sucursalFiltro)
            .in('status', ['confirmada', 'completada'])
            .gte('slot_inicio', riesgoDesdeISO)
        : supabase
            .from('reservas')
            .select('usuario_id, slot_inicio')
            .eq('tenant_id', tenant.id)
            .in('status', ['confirmada', 'completada'])
            .gte('slot_inicio', riesgoDesdeISO);

      const [historialRes, miembrosRes, reservasRes] = await Promise.all([
        supabase
          .from('usuario_status_historial')
          .select('usuario_id, status_nuevo, changed_at')
          .eq('tenant_id', tenant.id)
          .order('changed_at', { ascending: true }),
        miembrosQ,
        reservasQ
      ]);

      if (!mounted) return;

      const historial = (historialRes.data ?? []) as HistorialRow[];
      const miembros = (miembrosRes.data ?? []) as MiembroRow[];
      const reservas = (reservasRes.data ?? []) as unknown as { usuario_id: string; slot_inicio: string }[];

      const miembroIds = new Set(miembros.map((m) => m.id));

      // Historial por usuario (ya viene ordenado asc por changed_at).
      const historialPorUsuario = new Map<string, HistorialRow[]>();
      for (const e of historial) {
        const arr = historialPorUsuario.get(e.usuario_id);
        if (arr) arr.push(e);
        else historialPorUsuario.set(e.usuario_id, [e]);
      }

      // ── Churn de un rango ──
      function calcularChurn(rango: RangoReporte) {
        const desdeISO = instanteDeClase(rango.desde, '00:00', tz).toISOString();
        const hastaISO = instanteDeClase(rango.hasta, '23:59', tz).toISOString();

        const bajasSet = new Set<string>();
        for (const e of historial) {
          if (
            (e.status_nuevo === 'cancelado' || e.status_nuevo === 'suspendido') &&
            e.changed_at >= desdeISO &&
            e.changed_at <= hastaISO &&
            miembroIds.has(e.usuario_id)
          ) {
            bajasSet.add(e.usuario_id);
          }
        }

        let activosInicio = 0;
        for (const m of miembros) {
          const ent = historialPorUsuario.get(m.id) ?? [];
          if (statusEnFecha(ent, desdeISO) === 'activo') activosInicio++;
        }

        const bajas = bajasSet.size;
        const tasaChurnPct =
          activosInicio > 0 ? Math.round((bajas / activosInicio) * 1000) / 10 : null;
        return { bajas, activosInicio, tasaChurnPct };
      }

      const churnActual = calcularChurn(rangoActual);
      const churnAnterior = calcularChurn(rangoAnterior);

      // ── Miembros activos: ahora vs fin del período anterior ──
      const activosAhora = miembros.filter((m) => m.status === 'activo').length;
      const finAnteriorISO = instanteDeClase(rangoAnterior.hasta, '23:59', tz).toISOString();
      let activosFinAnterior = 0;
      for (const m of miembros) {
        const ent = historialPorUsuario.get(m.id) ?? [];
        if (statusEnFecha(ent, finAnteriorISO) === 'activo') activosFinAnterior++;
      }

      // ── Cohortes de retención (últimos 6 meses de alta) ──
      const mesActual = hoy.slice(0, 7);
      const miembrosPorCohorte = new Map<string, MiembroRow[]>();
      for (const m of miembros) {
        const cohorte = m.created_at.slice(0, 7);
        const arr = miembrosPorCohorte.get(cohorte);
        if (arr) arr.push(m);
        else miembrosPorCohorte.set(cohorte, [m]);
      }

      const cohortes: CohorteRetencion[] = [];
      for (let i = 5; i >= 0; i--) {
        const mes = sumarMeses(mesActual, -i);
        const miembrosCohorte = miembrosPorCohorte.get(mes) ?? [];
        const tamano = miembrosCohorte.length;
        const retencion: (number | null)[] = [1, 2, 3].map((k) => {
          if (tamano === 0) return null;
          const targetISO = instanteDeClase(`${sumarMeses(mes, k)}-01`, '00:00', tz).toISOString();
          if (targetISO > nowISO) return null; // cohorte aún muy joven para este offset
          let activos = 0;
          for (const m of miembrosCohorte) {
            const ent = historialPorUsuario.get(m.id) ?? [];
            if (statusEnFecha(ent, targetISO) === 'activo') activos++;
          }
          return Math.round((activos / tamano) * 1000) / 10;
        });
        cohortes.push({ mes, label: labelMes(mes), tamano, retencion });
      }

      // ── Retención 3 meses (headline): cohorte de hace 3 meses, hoy activa ──
      const mesHace3 = sumarMeses(mesActual, -3);
      const cohorte3 = miembrosPorCohorte.get(mesHace3) ?? [];
      const activos3 = cohorte3.filter((m) => m.status === 'activo').length;
      const retencion3m = {
        pct: cohorte3.length > 0 ? Math.round((activos3 / cohorte3.length) * 1000) / 10 : null,
        tamanoCohorte: cohorte3.length,
        label: labelMes(mesHace3)
      };

      // ── Miembros en riesgo ──
      // Última actividad por usuario = reserva (pasada o futura) más reciente.
      const ultimaActividadPorUsuario = new Map<string, string>();
      for (const r of reservas) {
        const prev = ultimaActividadPorUsuario.get(r.usuario_id);
        if (!prev || r.slot_inicio > prev) {
          ultimaActividadPorUsuario.set(r.usuario_id, r.slot_inicio);
        }
      }
      const umbralISO = new Date(Date.now() - RIESGO_UMBRAL_DIAS * DIA_MS).toISOString();
      const miembrosRiesgo: MiembroRiesgo[] = miembros
        .filter((m) => m.status === 'activo')
        .map((m) => {
          const ultima = ultimaActividadPorUsuario.get(m.id) ?? null;
          return {
            id: m.id,
            nombre: m.nombre ?? m.email,
            email: m.email,
            ultimaActividad: ultima,
            diasSinActividad: ultima
              ? Math.floor((Date.now() - new Date(ultima).getTime()) / DIA_MS)
              : null
          };
        })
        // En riesgo = sin actividad reciente (o sin ninguna reserva en la ventana).
        .filter((m) => m.ultimaActividad === null || m.ultimaActividad < umbralISO)
        // Más urgentes primero: sin actividad conocida arriba, luego por días desc.
        .sort((a, b) => {
          if (a.diasSinActividad === null) return b.diasSinActividad === null ? 0 : -1;
          if (b.diasSinActividad === null) return 1;
          return b.diasSinActividad - a.diasSinActividad;
        });

      setData({
        churn: {
          bajas: churnActual.bajas,
          bajasAnterior: churnAnterior.bajas,
          activosInicio: churnActual.activosInicio,
          tasaChurnPct: churnActual.tasaChurnPct,
          tasaChurnPctAnterior: churnAnterior.tasaChurnPct
        },
        miembrosActivos: { actual: activosAhora, anterior: activosFinAnterior },
        cohortes,
        retencion3m,
        miembrosRiesgo
      });
      setIsLoading(false);
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [tenant.id, tz, periodo, sucursalFiltro]);

  return { data, isLoading };
}
