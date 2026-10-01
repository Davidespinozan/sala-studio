import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * W6-A2 — Cliente del inbox durable de Stripe (A1). Encapsula la máquina de
 * estados para que ambos webhooks compartan exactamente el mismo transporte:
 *   receive (idempotente) → claim (atómico) → dispatcher (efecto + processed en
 *   una tx) → failed/dead ante error. Sin delete-on-error.
 *
 * El `payload` que se persiste son los ARGS mínimos del dispatcher (whitelist por
 * construcción; sin tarjetas/PII): sirven para replay sin re-fetch en el caso común.
 */

export interface InboxReceive {
  id: string;
  flujo: 'socio' | 'saas';
  type: string;
  account: string | null;
  tenant: string | null;
  objectId: string | null;
  created: string; // ISO
  payload: Record<string, unknown>;
}

export async function inboxReceive(admin: SupabaseClient, r: InboxReceive): Promise<{ nuevo: boolean; estado: string }> {
  const { data, error } = await admin.rpc('_stripe_inbox_receive' as never, {
    p_event_id: r.id, p_flujo: r.flujo, p_type: r.type, p_account: r.account,
    p_tenant: r.tenant, p_object_id: r.objectId, p_created: r.created, p_payload: r.payload
  } as never);
  if (error) throw error;
  return data as { nuevo: boolean; estado: string };
}

/** Reclama el evento para procesar. `claimed=false` si ya está processing/processed/dead. */
export async function inboxClaim(admin: SupabaseClient, id: string): Promise<{ claimed: boolean; estado: string | null }> {
  const { data, error } = await admin.rpc('_stripe_inbox_claim' as never, { p_event_id: id } as never);
  if (error) throw error;
  const row = data as { id: string | null; estado: string | null } | null;
  return { claimed: !!row && !!row.id, estado: row?.estado ?? null };
}

/** Marca processed (solo desde processing). Idempotente. */
export async function inboxProcessed(admin: SupabaseClient, id: string): Promise<void> {
  const { error } = await admin.rpc('_stripe_inbox_processed' as never, { p_event_id: id } as never);
  if (error) throw error;
}

/** Marca failed (o dead si agotó intentos). El evento NUNCA se borra. */
export async function inboxFailed(admin: SupabaseClient, id: string, err: unknown): Promise<string | null> {
  const msg = err instanceof Error ? err.message : String(err);
  const { data } = await admin.rpc('_stripe_inbox_failed' as never, {
    p_event_id: id, p_error: msg.slice(0, 500), p_max_intentos: 5
  } as never);
  return (data as string | null) ?? null; // 'failed' | 'dead' | null
}
