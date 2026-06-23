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
// MOCK DE PAGO — leer antes de tocar
// ════════════════════════════════════════════════════════════════════════════
// Hoy `crearSuscripcion()` SIMULA el pago: escribe directo la fila de
// suscripciones_saas con estado 'trial' e ids 'mock_*'. NO cobra nada.
//
// Para enchufar Stripe real (S7 real) se cambia SOLO el cuerpo de
// `crearSuscripcion` — la firma y el resto de la app quedan igual:
//   1. Llamar a una Edge Function que cree un Stripe Checkout Session
//      (mode: 'subscription', trial_period_days: TRIAL_DIAS, price del
//      tier/moneda, customer del tenant).
//   2. Redirigir al admin a session.url; al volver, Stripe confirma el pago.
//   3. La fila de suscripciones_saas la crea/actualiza el WEBHOOK de Stripe
//      (checkout.session.completed / customer.subscription.updated), no el
//      cliente. Los campos stripe_customer_id / stripe_subscription_id se
//      llenan con los ids reales.
//
// `useSuscripcion` y toda la UI leen suscripciones_saas igual — no se enteran
// de si el pago fue mock o real. Ese es el punto del aislamiento.
//
// PRECIOS: en Stripe habrá 9 Prices (3 tiers × 3 monedas). A cada gym se le
// asigna el Price de SU moneda de mercado — la que devuelve monedaDelTenant()
// según su timezone. Son precios fijos independientes: NO hay conversión
// automática entre monedas ni el usuario elige moneda.
// ════════════════════════════════════════════════════════════════════════════

/** true mientras el pago sea simulado. La UI lo usa para marcar "MODO DEMO". */
export const PAGO_ES_MOCK = true;

function mockId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

export interface CrearSuscripcionParams {
  tenantId: string;
  tier: TierSaas;
  moneda: MonedaSaas;
}

/**
 * Crea o cambia la suscripción del tenant. MOCK: escribe la fila directamente
 * con estado 'trial'. Ver el bloque de comentarios de arriba para Stripe real.
 */
export async function crearSuscripcion(
  params: CrearSuscripcionParams
): Promise<{ error: string | null }> {
  const { tenantId, tier, moneda } = params;

  const ahora = Date.now();
  const finTrial = new Date(ahora + TRIAL_DIAS * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase.from('suscripciones_saas').upsert(
    {
      tenant_id: tenantId,
      tier,
      moneda,
      estado: 'trial',
      trial_termina: finTrial,
      // Durante el trial, el próximo cobro cae al terminar el trial.
      periodo_actual_termina: finTrial,
      precio_centavos: precioCentavos(tier, moneda),
      stripe_customer_id: mockId('mock_cus'),
      stripe_subscription_id: mockId('mock_sub'),
      cancelada_at: null
    },
    { onConflict: 'tenant_id' }
  );

  return { error: error?.message ?? null };
}

/**
 * Cancela la suscripción. MOCK: marca estado 'cancelada'. Con Stripe real,
 * esto llamaría a stripe.subscriptions.cancel() y el webhook actualizaría la
 * fila.
 */
export async function cancelarSuscripcion(
  suscripcionId: string
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('suscripciones_saas')
    .update({ estado: 'cancelada', cancelada_at: new Date().toISOString() })
    .eq('id', suscripcionId);

  return { error: error?.message ?? null };
}
