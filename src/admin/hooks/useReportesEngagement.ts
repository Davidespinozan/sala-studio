import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '../providers/SucursalProvider';

/**
 * Engagement del gym (snapshot, ventanas fijas):
 *   - MAU  = socios activos con clase (reserva confirmada/completada) en 30d.
 *   - % que vienen = MAU ÷ socios activos → el inverso es "pagan pero no vienen".
 *   - Stickiness = DAU promedio ÷ MAU (qué tan seguido vuelven los que vienen).
 *   - Activación = % de altas (cohorte 90d) que llegaron a su 1ª reserva.
 *   - Tiempo a 1ª reserva = días promedio del alta a la primera reserva.
 *
 * Todo sale de usuarios + reservas; sin Stripe.
 */
export interface ReportesEngagementData {
  mau: number;
  activosTotal: number;
  vienenPct: number | null;
  dauProm: number;
  stickinessPct: number | null;
  activacionPct: number | null;
  ttvDias: number | null;
  cohorteAltas: number;
}

const DIA_MS = 86_400_000;
const VENTANA_DAU = 30;
const VENTANA_RESERVAS = 95; // cubre la vida del cohorte de activación (90d)
const VENTANA_COHORTE = 90;

interface MiembroRow {
  id: string;
  created_at: string;
  status: string;
}
interface ReservaRow {
  usuario_id: string;
  slot_inicio: string;
  created_at: string;
  status: string;
}

export function useReportesEngagement() {
  const tenant = useTenant();
  const { sucursalFiltro } = useSucursal();
  const [data, setData] = useState<ReportesEngagementData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);

    async function load() {
      const ahora = Date.now();
      const nowISO = new Date(ahora).toISOString();
      const desdeReservasISO = new Date(ahora - VENTANA_RESERVAS * DIA_MS).toISOString();
      const hace30ISO = new Date(ahora - VENTANA_DAU * DIA_MS).toISOString();
      const hace90ISO = new Date(ahora - VENTANA_COHORTE * DIA_MS).toISOString();

      let miembrosQ = supabase
        .from('usuarios')
        .select('id, created_at, status')
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro');
      if (sucursalFiltro) miembrosQ = miembrosQ.eq('sucursal_id', sucursalFiltro);

      // reservas de la sede = reservas cuyo recurso es de esa sede.
      const reservasQ = sucursalFiltro
        ? supabase
            .from('reservas')
            .select('usuario_id, slot_inicio, created_at, status, recurso:recursos!inner(sucursal_id)')
            .eq('tenant_id', tenant.id)
            .eq('recurso.sucursal_id', sucursalFiltro)
            .in('status', ['confirmada', 'completada'])
            .gte('slot_inicio', desdeReservasISO)
        : supabase
            .from('reservas')
            .select('usuario_id, slot_inicio, created_at, status')
            .eq('tenant_id', tenant.id)
            .in('status', ['confirmada', 'completada'])
            .gte('slot_inicio', desdeReservasISO);

      const [miembrosRes, reservasRes] = await Promise.all([miembrosQ, reservasQ]);

      if (!mounted) return;

      const miembros = (miembrosRes.data ?? []) as MiembroRow[];
      const reservas = (reservasRes.data ?? []) as unknown as ReservaRow[];

      const activosSet = new Set(miembros.filter((m) => m.status === 'activo').map((m) => m.id));
      const activosTotal = activosSet.size;

      // ── DAU/MAU: socios ACTIVOS con clase en los últimos 30 días (pasada) ──
      const mauSet = new Set<string>();
      const memberDays = new Set<string>();
      for (const r of reservas) {
        if (r.slot_inicio < hace30ISO || r.slot_inicio > nowISO) continue;
        if (!activosSet.has(r.usuario_id)) continue;
        mauSet.add(r.usuario_id);
        memberDays.add(`${r.usuario_id}|${r.slot_inicio.slice(0, 10)}`);
      }
      const mau = mauSet.size;
      const dauProm = Math.round((memberDays.size / VENTANA_DAU) * 10) / 10;
      const vienenPct = activosTotal > 0 ? Math.round((mau / activosTotal) * 1000) / 10 : null;
      const stickinessPct = mau > 0 ? Math.round((dauProm / mau) * 1000) / 10 : null;

      // ── Activación: cohorte de altas en 90d que llegaron a su 1ª reserva ──
      const primeraReserva = new Map<string, string>(); // usuario_id → min(created_at)
      for (const r of reservas) {
        const prev = primeraReserva.get(r.usuario_id);
        if (!prev || r.created_at < prev) primeraReserva.set(r.usuario_id, r.created_at);
      }
      const cohorte = miembros.filter((m) => m.created_at >= hace90ISO);
      let activados = 0;
      let ttvSum = 0;
      let ttvN = 0;
      for (const m of cohorte) {
        const fr = primeraReserva.get(m.id);
        if (!fr) continue;
        activados++;
        const dias = (Date.parse(fr) - Date.parse(m.created_at)) / DIA_MS;
        if (dias >= 0) {
          ttvSum += dias;
          ttvN++;
        }
      }
      const activacionPct = cohorte.length > 0 ? Math.round((activados / cohorte.length) * 1000) / 10 : null;
      const ttvDias = ttvN > 0 ? Math.round((ttvSum / ttvN) * 10) / 10 : null;

      setData({
        mau,
        activosTotal,
        vienenPct,
        dauProm,
        stickinessPct,
        activacionPct,
        ttvDias,
        cohorteAltas: cohorte.length
      });
      setIsLoading(false);
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [tenant.id, sucursalFiltro]);

  return { data, isLoading };
}
