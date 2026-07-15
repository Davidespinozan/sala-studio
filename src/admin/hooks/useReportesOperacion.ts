import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '../providers/SucursalProvider';

/**
 * Operación: conversión de lista de espera (últimos 90 días) y créditos sin usar
 * / por vencer (membresías por paquete). Sin Stripe.
 */
export interface ReportesOperacionData {
  esperaEntradas: number;
  esperaPromovidos: number;
  esperaConversionPct: number | null;
  creditosSinUsar: number;
  membresiasConCreditos: number;
  creditosPorVencer: number;
  membresiasPorVencer: number;
}

const DIA_MS = 86_400_000;
const VENTANA_ESPERA = 90;
const VENCE_DIAS = 14;
// Membresías que cuentan como vigentes (mismas que el member para "actual").
const STATUS_VIGENTES = ['trialing', 'activa', 'past_due', 'congelada'];

interface EsperaRow {
  status: string;
}
interface MembresiaRow {
  creditos_restantes: number | null;
  periodo_actual_fin: string | null;
}

export function useReportesOperacion() {
  const tenant = useTenant();
  const { sucursalFiltro } = useSucursal();
  const [data, setData] = useState<ReportesOperacionData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);

    async function load() {
      const ahora = Date.now();
      const hace90ISO = new Date(ahora - VENTANA_ESPERA * DIA_MS).toISOString();
      const nowISO = new Date(ahora).toISOString();
      const venceISO = new Date(ahora + VENCE_DIAS * DIA_MS).toISOString();

      // lista_espera no tiene sede: se filtra por la sede de la clase.
      const esperaQ = sucursalFiltro
        ? supabase
            .from('lista_espera')
            .select('status, clase:clases!inner(sucursal_id)')
            .eq('tenant_id', tenant.id)
            .eq('clase.sucursal_id', sucursalFiltro)
            .gte('created_at', hace90ISO)
        : supabase
            .from('lista_espera')
            .select('status')
            .eq('tenant_id', tenant.id)
            .gte('created_at', hace90ISO);

      let memQ = supabase
        .from('membresias')
        .select('creditos_restantes, periodo_actual_fin')
        .eq('tenant_id', tenant.id)
        .in('status', STATUS_VIGENTES)
        .gt('creditos_restantes', 0);
      if (sucursalFiltro) memQ = memQ.eq('sucursal_id', sucursalFiltro);

      const [esperaRes, memRes] = await Promise.all([esperaQ, memQ]);

      if (!mounted) return;

      const espera = (esperaRes.data ?? []) as unknown as EsperaRow[];
      const mems = (memRes.data ?? []) as MembresiaRow[];

      // ── Lista de espera: conversión = promovidos / resueltos (prom + cancel) ──
      const esperaEntradas = espera.length;
      const esperaPromovidos = espera.filter((e) => e.status === 'promovido').length;
      const cancelados = espera.filter((e) => e.status === 'cancelado').length;
      const resueltos = esperaPromovidos + cancelados;
      const esperaConversionPct =
        resueltos > 0 ? Math.round((esperaPromovidos / resueltos) * 1000) / 10 : null;

      // ── Créditos: sin usar (vigentes, no vencidos) + por vencer en 14 días ──
      let creditosSinUsar = 0;
      let membresiasConCreditos = 0;
      let creditosPorVencer = 0;
      let membresiasPorVencer = 0;
      for (const m of mems) {
        const cr = m.creditos_restantes ?? 0;
        if (cr <= 0) continue;
        const fin = m.periodo_actual_fin;
        if (fin != null && fin <= nowISO) continue; // paquete ya vencido
        creditosSinUsar += cr;
        membresiasConCreditos++;
        if (fin != null && fin > nowISO && fin <= venceISO) {
          creditosPorVencer += cr;
          membresiasPorVencer++;
        }
      }

      setData({
        esperaEntradas,
        esperaPromovidos,
        esperaConversionPct,
        creditosSinUsar,
        membresiasConCreditos,
        creditosPorVencer,
        membresiasPorVencer
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
