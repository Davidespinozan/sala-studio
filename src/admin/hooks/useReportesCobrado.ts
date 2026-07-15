import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '../providers/SucursalProvider';
import { calcularRango, type PeriodoReporte } from './useReportes';

export interface ReportesCobradoData {
  /** Neto del período: cobros − reembolsos, sin cortesías. Lo que REALMENTE entró. */
  cobradoCentavos: number;
  /** Reembolsos del período (positivo), ya restados del neto. */
  devueltoCentavos: number;
  /** Cobros reales (sin cortesías ni reembolsos). */
  transacciones: number;
  moneda: string;
  /** Ingreso por concepto (plan, paquete, inscripción…), sin cortesías ni reembolsos. */
  porConcepto: { concepto: string; centavos: number }[];
}

const CONCEPTO_LABEL: Record<string, string> = {
  plan: 'Mensualidades',
  paquete: 'Paquetes',
  inscripcion: 'Inscripciones',
  otro: 'Otros',
};

function hoyLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * El dinero REAL cobrado en el período elegido, leído de `pagos`. Es el gemelo
 * honesto del bloque de Economía (que PROYECTA a precio de lista): esto es lo que
 * de verdad entró — efectivo, tarjeta, transferencia, Stripe — neto de
 * reembolsos y sin cortesías.
 *
 * Sede: igual que el resto, solo filtra cuando el gym tiene varias sucursales y
 * hay una elegida (si no, tiraría los cobros online sin sede).
 */
export function useReportesCobrado(periodo: PeriodoReporte) {
  const tenant = useTenant();
  const { sucursalFiltro } = useSucursal();
  const [data, setData] = useState<ReportesCobradoData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    (async () => {
      const rango = calcularRango(periodo, hoyLocal());
      // El período viene en fechas (YYYY-MM-DD) locales; las llevamos a instantes
      // para comparar contra pagos.created_at (timestamptz). `hasta` es inclusivo,
      // así que el corte de arriba es el día siguiente a las 00:00.
      const desdeISO = new Date(`${rango.desde}T00:00:00`).toISOString();
      const hastaISO = new Date(`${rango.hasta}T00:00:00`);
      hastaISO.setDate(hastaISO.getDate() + 1);

      let q = supabase
        .from('pagos')
        .select('monto_centavos, moneda, metodo, concepto, sucursal_id')
        .eq('tenant_id', tenant.id)
        .gte('created_at', desdeISO)
        .lt('created_at', hastaISO.toISOString());

      // null = todas o mono-sede: no filtrar.
      if (sucursalFiltro) q = q.eq('sucursal_id', sucursalFiltro);

      const { data: rows, error } = await q;
      if (cancelled) return;
      if (error) {
        console.error('[useReportesCobrado]', error);
        setIsLoading(false);
        return;
      }

      const pagos = (rows ?? []) as {
        monto_centavos: number;
        moneda: string;
        metodo: string;
        concepto: string;
      }[];

      let cobrado = 0;
      let devuelto = 0;
      let transacciones = 0;
      const moneda = pagos.find((p) => p.moneda)?.moneda ?? 'MXN';
      const porConcepto = new Map<string, number>();

      for (const p of pagos) {
        if (p.metodo !== 'cortesia') cobrado += p.monto_centavos;
        if (p.concepto === 'reembolso') {
          devuelto += -p.monto_centavos;
        } else if (p.metodo !== 'cortesia') {
          transacciones++;
          porConcepto.set(p.concepto, (porConcepto.get(p.concepto) ?? 0) + p.monto_centavos);
        }
      }

      setData({
        cobradoCentavos: cobrado,
        devueltoCentavos: devuelto,
        transacciones,
        moneda,
        porConcepto: [...porConcepto.entries()]
          .map(([concepto, centavos]) => ({
            concepto: CONCEPTO_LABEL[concepto] ?? concepto,
            centavos,
          }))
          .sort((a, b) => b.centavos - a.centavos),
      });
      setIsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [tenant.id, sucursalFiltro, periodo]);

  return { data, isLoading };
}
