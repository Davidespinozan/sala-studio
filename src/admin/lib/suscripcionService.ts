import { supabase } from '@shared/lib/supabase';
import { precioCentavos, TRIAL_DIAS, type TierSaas, type MonedaSaas } from './planesSaas';

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
