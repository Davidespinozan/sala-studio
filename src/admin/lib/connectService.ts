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
