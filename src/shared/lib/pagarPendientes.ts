import { backendPost } from '@shared/lib/backend';

export interface PagarPendientesResult {
  /** URL de Stripe Checkout: se redirige. */
  url?: string;
  /** 'sin_cargos' | 'cobros_no_activos' | 'stripe_pendiente' */
  reason?: string;
  total_centavos?: number;
}

/**
 * "Pagar con tarjeta" los cargos pendientes del socio (plan elegido con "Pagar
 * en recepción", inscripción…). Abre Stripe Checkout sobre la cuenta del gym; el
 * webhook asienta el pago y marca los cargos cobrados (stripe_cobrar_cargos_pendientes).
 */
export async function pagarPendientesConTarjeta(): Promise<PagarPendientesResult> {
  const res = await backendPost<PagarPendientesResult>('pagar-cargo-pendiente', {});
  if (res.url) window.location.href = res.url;
  return res;
}
