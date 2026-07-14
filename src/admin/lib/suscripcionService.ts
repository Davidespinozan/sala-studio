import { supabase } from '@shared/lib/supabase';
import { backendPost } from '@shared/lib/backend';
import { precioCentavos, TRIAL_DIAS, type TierSaas, type MonedaSaas } from '@shared/lib/planesSaas';

export interface CheckoutSaasResult {
  /** URL de la Stripe Checkout Session → redirigir. */
  url?: string;
  /** Reservado: true si quedó activa ya. */
  activated?: boolean;
  /** 'stripe_pendiente' cuando el tenant es real y Stripe aún no está conectado. */
  reason?: string;
}

/**
 * Checkout REAL del SaaS (tenant→SALA) vía la function `suscribir-saas`. El
 * backend decide: `{ url }` → redirige a Stripe Checkout; `{ activated:false,
 * reason:'stripe_pendiente' }` → Stripe aún no conectado (UI: "pago en camino").
 * El DEMO sigue usando `crearSuscripcion` (mock) — la rama vive en Suscripcion.tsx.
 */
export async function iniciarCheckoutSaas(params: {
  tier: TierSaas;
  moneda: MonedaSaas;
  returnPath?: string;
}): Promise<CheckoutSaasResult> {
  const res = await backendPost<CheckoutSaasResult>('suscribir-saas', {
    tier: params.tier,
    moneda: params.moneda,
    ciclo: 'mensual',
    return_path: params.returnPath
  });
  if (res.url) window.location.href = res.url;
  return res;
}

export interface CancelacionSaasResult {
  ok?: boolean;
  cancel_at_period_end?: boolean;
  reason?: string;
}

/**
 * Cancela (cancel_at_period_end:true) o reactiva (false) la suscripción REAL del
 * gym vía `cancelar-saas`. El webhook sincroniza suscripciones_saas. Solo para
 * tenants reales; el DEMO usa cancelarSuscripcion (mock).
 */
export async function cambiarCancelacionSaas(reactivar: boolean): Promise<CancelacionSaasResult> {
  return backendPost<CancelacionSaasResult>('cancelar-saas', { reactivar });
}

/**
 * Abre el Stripe Customer Portal de la suscripción del gym a SALA (gestionar
 * tarjeta, ver facturas, cancelar). Redirige si hay url.
 */
export async function abrirPortalSaas(returnPath?: string): Promise<{ url: string | null; reason?: string }> {
  const res = await backendPost<{ url: string | null; reason?: string }>('portal-saas', { return_path: returnPath });
  if (res.url) window.location.href = res.url;
  return res;
}

// ════════════════════════════════════════════════════════════════════════════
// MOCK DE PAGO — SOLO PARA EL TENANT DEMO
// ════════════════════════════════════════════════════════════════════════════
// `crearSuscripcion()` simula el pago del demo: deja la suscripción en 'trial'
// con ids 'mock_*'. NO cobra nada. Un gym real NO pasa por acá — va a Stripe
// (iniciarCheckoutSaas → suscribir-saas), y la fila la escribe el webhook.
//
// El demo NO escribe la tabla: llama a una RPC que valida en el servidor que el
// tenant sea el demo. Antes escribía `suscripciones_saas` directo, lo que
// obligaba a darle a TODO admin permiso de escritura sobre su propia suscripción
// al SaaS — o sea, la posibilidad de ponerse estado 'activa' y precio 0 con un
// PATCH desde el navegador. Hoy la tabla es de solo lectura para el gym.
//
// `useSuscripcion` y toda la UI leen suscripciones_saas igual — no se enteran de
// si el pago fue mock o real. Ese es el punto del aislamiento.
//
// PRECIOS: en Stripe hay 9 Prices (3 tiers × 3 monedas). A cada gym se le asigna
// el Price de SU moneda de mercado — la que devuelve monedaDelTenant() según su
// timezone. Son precios fijos independientes: NO hay conversión automática entre
// monedas ni el usuario elige moneda.
// ════════════════════════════════════════════════════════════════════════════

/** true mientras el pago sea simulado. La UI lo usa para marcar "MODO DEMO". */
export const PAGO_ES_MOCK = true;

export interface CrearSuscripcionParams {
  tenantId: string;
  tier: TierSaas;
  moneda: MonedaSaas;
}

/**
 * Crea o cambia la suscripción del tenant. MOCK: pasa por una RPC que valida en
 * el SERVIDOR que el tenant sea el demo. Antes esto escribía la tabla directo,
 * lo que implicaba dejarle a todo admin permiso de escritura sobre su propia
 * suscripción al SaaS — o sea, poder ponerse el plan gratis desde el navegador.
 * La tabla ahora es de solo lectura para el gym; la escribe Stripe.
 */
export async function crearSuscripcion(
  params: CrearSuscripcionParams
): Promise<{ error: string | null }> {
  const { tier, moneda } = params;

  // RPC nueva: aún no está en los tipos generados de Supabase.
  const { error } = await supabase.rpc('demo_suscripcion_mock' as never, {
    p_tier: tier,
    p_moneda: moneda,
    p_precio_centavos: precioCentavos(tier, moneda),
    p_trial_dias: TRIAL_DIAS
  } as never);

  return { error: error?.message ?? null };
}

/**
 * Cancela la suscripción del demo. Un gym real cancela por Stripe
 * (`cambiarCancelacionSaas`), y el webhook sincroniza la fila.
 */
export async function cancelarSuscripcion(): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('demo_suscripcion_cancelar' as never);
  return { error: error?.message ?? null };
}
