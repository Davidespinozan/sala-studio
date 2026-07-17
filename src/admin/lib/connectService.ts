import { backendPost } from '@shared/lib/backend';

// ════════════════════════════════════════════════════════════════════════════
// Flujo 2 (gym → socios) — Stripe Connect Express. El gym es la cuenta conectada
// que cobra a sus socios; SALA es la plataforma. Estos helpers manejan el
// onboarding hospedado y el estado de la cuenta. Inerte hasta conectar Stripe.
// ════════════════════════════════════════════════════════════════════════════

export interface ConnectEstado {
  /** Existe una cuenta conectada para el tenant. */
  connected: boolean;
  /** La cuenta puede COBRAR (onboarding completo y verificado). */
  charges_enabled: boolean;
  /** El dueño completó el formulario de onboarding. */
  details_submitted: boolean;
  /** Stripe puede depositar a su banco. */
  payouts_enabled: boolean;
  /** 'stripe_pendiente' cuando Stripe aún no está conectado. */
  reason?: string;

  // ── Enriquecidos: solo vienen cuando connected. Cada uno puede faltar (el
  //    backend los pide a Stripe por separado y tolera que alguno falle).
  /** acct_… de la cuenta conectada del gym. */
  account_id?: string | null;
  business_name?: string | null;
  email?: string | null;
  /** Código de país ISO (MX, US…). */
  pais?: string | null;
  /** daily | weekly | monthly | manual */
  payout_interval?: string | null;
  /** Cuenta bancaria donde Stripe le deposita. */
  bank?: { bank_name: string | null; last4: string | null } | null;
  /** Plata del GYM en Stripe: lo liberado y lo que todavía está en camino. */
  balance?: { disponible_centavos: number; pendiente_centavos: number; moneda: string } | null;
  /** Link de un solo uso al panel Express de Stripe del gym. */
  dashboard_url?: string | null;
}

export async function obtenerEstadoConnect(): Promise<ConnectEstado> {
  return backendPost<ConnectEstado>('connect-status', {});
}

/** Inicia el onboarding hospedado. Si hay url, redirige. */
export async function iniciarOnboardingConnect(params?: {
  country?: string;
  returnPath?: string;
}): Promise<{ url: string | null; reason?: string }> {
  const res = await backendPost<{ url: string | null; reason?: string }>('connect-onboarding', {
    country: params?.country,
    return_path: params?.returnPath
  });
  if (res.url) window.location.href = res.url;
  return res;
}
