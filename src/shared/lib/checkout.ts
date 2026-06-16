import { backendPost } from '@shared/lib/backend';

export interface CheckoutResult {
  /** true si la membresía quedó activa ya (demo: pago simulado). */
  activated: boolean;
  /** 'stripe_pendiente' cuando es un tenant real y Stripe aún no está conectado. */
  reason?: string;
  /** Futuro Stripe: URL de la Checkout Session para redirigir. */
  url?: string;
  result?: unknown;
}

/**
 * Inicia la compra/cambio de plan del socio. ÚNICO punto de enchufe de Stripe en
 * el frontend: hoy la function `suscribir-membresia` activa el plan (demo) o
 * responde `stripe_pendiente` (tenant real). Cuando se conecte Stripe, la
 * function devolverá `{ url }` y acá redirigimos al checkout — sin tocar la UI.
 */
export async function iniciarCheckout(tierId: string): Promise<CheckoutResult> {
  const res = await backendPost<CheckoutResult>('suscribir-membresia', { tier_id: tierId });
  if (res.url) {
    window.location.href = res.url; // futuro: Stripe Checkout Session
  }
  return res;
}
