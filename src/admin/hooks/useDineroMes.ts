import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '../providers/SucursalProvider';
import { getTenantTimezone, hoyEnTimezone } from '@shared/lib/timezone';
import { fromZonedTime } from 'date-fns-tz';

export interface DineroMes {
  /** Neto del mes: cobros − reembolsos, sin contar cortesías. */
  cobradoCentavos: number;
  /** Lo devuelto este mes (positivo), ya restado del neto. */
  devueltoCentavos: number;
  moneda: string;
  /** Cuántos cobros reales hubo (sin cortesías ni reembolsos). */
  transacciones: number;
}

/**
 * El dinero REAL cobrado en el mes en curso, leído de `pagos` — el mismo libro
 * que Caja. No estima nada: cuenta lo que efectivamente entró (efectivo,
 * tarjeta, transferencia, Stripe), descuenta reembolsos y excluye cortesías.
 *
 * Sede: solo filtra por sucursal cuando el gym tiene VARIAS y hay una elegida.
 * En un gym de una sola sede no se filtra, porque los cobros online (Stripe)
 * llegan con `sucursal_id` NULL y el filtro los tiraría.
 */
export function useDineroMes() {
  const tenant = useTenant();
  const { sucursalFiltro } = useSucursal();
  const [data, setData] = useState<DineroMes | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    (async () => {
      // Inicio del mes en la zona del GYM (no del navegador): si el dueño abre
      // desde otra zona, "este mes" seguía siendo el del gym.
      const tz = getTenantTimezone(tenant);
      const hoy = hoyEnTimezone(tz);
      const inicioMesISO = fromZonedTime(`${hoy.slice(0, 8)}01T00:00:00`, tz).toISOString();

      let q = supabase
        .from('pagos')
        .select('monto_centavos, moneda, metodo, concepto, sucursal_id')
        .eq('tenant_id', tenant.id)
        .gte('created_at', inicioMesISO);

      // null = todas las sedes o gym mono-sede: no filtrar (no perder online).
      if (sucursalFiltro) q = q.eq('sucursal_id', sucursalFiltro);

      const { data: rows, error } = await q;
      if (cancelled) return;
      if (error) {
        console.error('[useDineroMes]', error);
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

      for (const p of pagos) {
        // La cortesía no es dinero que entró; no suma. Los reembolsos son
        // negativos, así que restan solos (misma lógica que Caja).
        if (p.metodo !== 'cortesia') cobrado += p.monto_centavos;
        if (p.concepto === 'reembolso') devuelto += -p.monto_centavos;
        else if (p.metodo !== 'cortesia') transacciones++;
      }

      setData({ cobradoCentavos: cobrado, devueltoCentavos: devuelto, moneda, transacciones });
      setIsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [tenant.id, sucursalFiltro]);

  return { data, isLoading };
}
