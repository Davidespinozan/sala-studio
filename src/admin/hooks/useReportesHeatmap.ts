import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '../providers/SucursalProvider';
import { getTenantTimezone } from '@shared/lib/timezone';

/**
 * Mapa de calor de demanda: reservas por DÍA de la semana × HORA, en la zona
 * horaria del tenant, de los últimos 90 días. Sirve para decidir cuándo
 * programar más clases (horas pico) y dónde recortar (valle). Sin Stripe.
 */
export interface ReportesHeatmapData {
  /** counts[hour 0-23][dow 0=Dom..6=Sáb] = reservas. */
  counts: number[][];
  /** Rango de horas con actividad (filas a mostrar). */
  horas: number[];
  maxCount: number;
  total: number;
}

const DIA_MS = 86_400_000;
const VENTANA_DIAS = 90;

const DOW_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

export function useReportesHeatmap() {
  const tenant = useTenant();
  const { sucursalFiltro } = useSucursal();
  const tz = getTenantTimezone(tenant);
  const [data, setData] = useState<ReportesHeatmapData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);

    async function load() {
      const desdeISO = new Date(Date.now() - VENTANA_DIAS * DIA_MS).toISOString();
      const reservasQ = sucursalFiltro
        ? supabase
            .from('reservas')
            .select('slot_inicio, recurso:recursos!inner(sucursal_id)')
            .eq('tenant_id', tenant.id)
            .eq('recurso.sucursal_id', sucursalFiltro)
            .in('status', ['confirmada', 'completada'])
            .gte('slot_inicio', desdeISO)
        : supabase
            .from('reservas')
            .select('slot_inicio')
            .eq('tenant_id', tenant.id)
            .in('status', ['confirmada', 'completada'])
            .gte('slot_inicio', desdeISO);
      const { data: rows } = await reservasQ;

      if (!mounted) return;

      const reservas = (rows ?? []) as unknown as { slot_inicio: string }[];

      // Formatter reutilizable: extrae día de la semana + hora local del tenant.
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        hour: '2-digit',
        hour12: false
      });

      const counts: number[][] = Array.from({ length: 24 }, () => Array(7).fill(0));
      for (const r of reservas) {
        const parts = fmt.formatToParts(new Date(r.slot_inicio));
        const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
        let hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
        if (hour === 24) hour = 0; // algunos motores devuelven '24' para medianoche
        const dow = DOW_MAP[wd] ?? 1;
        counts[hour][dow]++;
      }

      let total = 0;
      let maxCount = 0;
      let minH = 23;
      let maxH = 0;
      for (let h = 0; h < 24; h++) {
        for (let d = 0; d < 7; d++) {
          const c = counts[h][d];
          if (c > 0) {
            total += c;
            if (h < minH) minH = h;
            if (h > maxH) maxH = h;
            if (c > maxCount) maxCount = c;
          }
        }
      }
      if (total === 0) {
        minH = 6;
        maxH = 21;
      }
      const horas: number[] = [];
      for (let h = minH; h <= maxH; h++) horas.push(h);

      setData({ counts, horas, maxCount, total });
      setIsLoading(false);
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [tenant.id, tz, sucursalFiltro]);

  return { data, isLoading };
}
