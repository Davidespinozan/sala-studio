import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';

/**
 * Economía del gym (snapshot de HOY, independiente del período):
 *   - MRR   = Σ membresías activas RECURRENTES × precio mensual del tier
 *   - ARR   = MRR × 12
 *   - ARPU  = MRR ÷ miembros activos con plan recurrente
 *   - LTV   = ARPU × vida media (estimado; tope 36m)
 *   - Vida media = 1 ÷ churn mensual (bajas distintas en 90d ÷ 3 ÷ activos)
 *
 * El precio mensual se normaliza por `duracion_dias` (la fuente de verdad de la
 * vigencia): precio × 30 / dias. Así un plan de 90 días de $3.000 aporta $1.000
 * al mes, no $3.000. Los PASES de pago único (Day Pass, semana suelta) NO son
 * ingreso recurrente → no entran al MRR/ARR.
 *
 * Es ingreso CONTRATADO (lo que las membresías representan), no cobro real —
 * no depende de Stripe. Asume una sola moneda por tenant: si hubiera tiers en
 * varias, calcula sobre la moneda DOMINANTE (mayor MRR) y no suma monedas
 * distintas.
 */
export interface ReportesEconomiaData {
  moneda: string; // 'mxn' | 'usd' | 'eur' (la dominante)
  mrrCentavos: number;
  arrCentavos: number;
  arpuCentavos: number;
  ltvCentavos: number | null;
  lifespanMeses: number | null;
  lifespanTope: boolean; // true si la vida real supera el tope (36m)
  churnMensualPct: number | null;
  activosConPlan: number;
  ingresoPorPlan: { plan: string; mrrCentavos: number }[];
}

interface TierRow {
  slug: string;
  nombre: string;
  precio_centavos: number;
  moneda: string;
  periodo: string;
  tipo: string;
  duracion_dias: number | null;
  pago_unico: boolean;
}
interface UsuarioRow {
  membresia_tier: string | null;
}
interface HistRow {
  usuario_id: string;
  status_nuevo: string;
}

const VENTANA_CHURN_DIAS = 90;
const DIA_MS = 86_400_000;
const LIFESPAN_TOPE_MESES = 36;

/**
 * Precio del tier normalizado a MENSUAL (30 días), para comparar planes de
 * distinta duración. Usa `duracion_dias` como fuente de verdad: precio × 30/días.
 * Los pases de PAGO ÚNICO no son ingreso recurrente → 0. Fallback por `periodo`
 * para tiers viejos sin duracion_dias.
 */
export function precioMensual(t: TierRow): number {
  // No recurrente → fuera del MRR: pases de pago único, y PAQUETES de clases
  // (creditos/hibrido, que se compran una vez).
  if (t.pago_unico || t.tipo === 'creditos' || t.tipo === 'hibrido') return 0;
  // Fuente de verdad: la duración real del acceso.
  if (t.duracion_dias && t.duracion_dias > 0) {
    return Math.round((t.precio_centavos * 30) / t.duracion_dias);
  }
  // Fallback (tiers sin duracion_dias): por periodo.
  if (t.periodo === 'anual') return Math.round(t.precio_centavos / 12);
  if (t.periodo === 'quincenal') return t.precio_centavos * 2;
  return t.precio_centavos;
}

export function useReportesEconomia() {
  const tenant = useTenant();
  const [data, setData] = useState<ReportesEconomiaData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);

    async function load() {
      const desdeISO = new Date(Date.now() - VENTANA_CHURN_DIAS * DIA_MS).toISOString();

      const [tiersRes, activosRes, histRes] = await Promise.all([
        supabase
          .from('tiers')
          .select('slug, nombre, precio_centavos, moneda, periodo, tipo, duracion_dias, pago_unico')
          .eq('tenant_id', tenant.id)
          .eq('activo', true),
        supabase
          .from('usuarios')
          .select('membresia_tier')
          .eq('tenant_id', tenant.id)
          .eq('rol', 'miembro')
          .eq('status', 'activo'),
        supabase
          .from('usuario_status_historial')
          .select('usuario_id, status_nuevo')
          .eq('tenant_id', tenant.id)
          .gte('changed_at', desdeISO)
      ]);

      if (!mounted) return;

      // pago_unico es columna nueva (no está aún en los tipos generados) → unknown.
      const tiers = (tiersRes.data ?? []) as unknown as TierRow[];
      const activos = (activosRes.data ?? []) as UsuarioRow[];
      const hist = (histRes.data ?? []) as HistRow[];

      const tierBySlug = new Map(tiers.map((t) => [t.slug, t]));

      // MRR por moneda + por plan (solo miembros activos con tier de precio > 0).
      const mrrPorMoneda = new Map<string, number>();
      const mrrPorPlan = new Map<string, { nombre: string; mrr: number; moneda: string }>();
      let activosConPlan = 0;
      for (const u of activos) {
        if (!u.membresia_tier) continue;
        const t = tierBySlug.get(u.membresia_tier);
        if (!t) continue;
        const pm = precioMensual(t);
        if (pm <= 0) continue;
        activosConPlan++;
        mrrPorMoneda.set(t.moneda, (mrrPorMoneda.get(t.moneda) ?? 0) + pm);
        const cur = mrrPorPlan.get(t.slug) ?? { nombre: t.nombre, mrr: 0, moneda: t.moneda };
        cur.mrr += pm;
        mrrPorPlan.set(t.slug, cur);
      }

      // Moneda dominante (mayor MRR). Fallback: la del primer tier.
      let moneda = tiers[0]?.moneda ?? 'mxn';
      let mejor = -1;
      for (const [mon, mrr] of mrrPorMoneda) {
        if (mrr > mejor) {
          mejor = mrr;
          moneda = mon;
        }
      }

      const mrrCentavos = mrrPorMoneda.get(moneda) ?? 0;
      const arrCentavos = mrrCentavos * 12;
      const arpuCentavos = activosConPlan > 0 ? Math.round(mrrCentavos / activosConPlan) : 0;
      const ingresoPorPlan = [...mrrPorPlan.values()]
        .filter((p) => p.moneda === moneda)
        .map((p) => ({ plan: p.nombre, mrrCentavos: p.mrr }))
        .sort((a, b) => b.mrrCentavos - a.mrrCentavos);

      // Churn mensual: bajas distintas (cancelado/suspendido) en 90d ÷ 3 ÷ activos.
      const bajasSet = new Set<string>();
      for (const e of hist) {
        if (e.status_nuevo === 'cancelado' || e.status_nuevo === 'suspendido') {
          bajasSet.add(e.usuario_id);
        }
      }
      const activosTotal = activos.length;
      const bajasMensuales = bajasSet.size / (VENTANA_CHURN_DIAS / 30);
      const churnMensual = activosTotal > 0 && bajasMensuales > 0 ? bajasMensuales / activosTotal : null;
      const churnMensualPct = churnMensual == null ? null : Math.round(churnMensual * 1000) / 10;

      let lifespanMeses: number | null = null;
      let lifespanTope = false;
      if (churnMensual != null && churnMensual > 0) {
        const real = Math.round(1 / churnMensual);
        lifespanTope = real > LIFESPAN_TOPE_MESES;
        lifespanMeses = Math.min(real, LIFESPAN_TOPE_MESES);
      }
      const ltvCentavos = lifespanMeses != null ? arpuCentavos * lifespanMeses : null;

      setData({
        moneda,
        mrrCentavos,
        arrCentavos,
        arpuCentavos,
        ltvCentavos,
        lifespanMeses,
        lifespanTope,
        churnMensualPct,
        activosConPlan,
        ingresoPorPlan
      });
      setIsLoading(false);
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [tenant.id]);

  return { data, isLoading };
}
