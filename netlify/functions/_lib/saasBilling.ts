// ════════════════════════════════════════════════════════════════════════════
// Helpers del Flujo 1 (SALA → gyms). Portados de healthyspaceclub a Node + el
// schema de SALA (suscripciones_saas). Patrones clave de HSC:
//   · lookup_keys estables (NO price_ids hardcodeados: no sobreviven test→live).
//   · get-or-create customer anti-duplicados + idempotencyKey.
//   · mapeo status de Stripe → estado interno (con gracia de past_due).
// ════════════════════════════════════════════════════════════════════════════
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Stripe } from './stripe';

// Catálogo válido del SaaS (espejo server-side de planesSaas.ts). El cliente
// manda { tier, moneda, ciclo } y el server arma la lookup_key → no puede
// inyectar una key arbitraria. Si cambian en planesSaas.ts, actualizar acá.
export const TIERS_SAAS = ['starter', 'pro', 'business'] as const;
export const MONEDAS_SAAS = ['mxn', 'usd', 'eur'] as const;
export const CICLOS_SAAS = ['mensual', 'anual'] as const;
export type TierSaas = (typeof TIERS_SAAS)[number];
export type MonedaSaas = (typeof MONEDAS_SAAS)[number];
export type CicloSaas = (typeof CICLOS_SAAS)[number];

/** Construye la lookup_key estable: `sala_<tier>_<moneda>_<ciclo>`.
 *  Devuelve null si algún componente no es válido (defensa anti-inyección). */
export function lookupKeyFor(tier: string, moneda: string, ciclo: string): string | null {
  if (!TIERS_SAAS.includes(tier as TierSaas)) return null;
  if (!MONEDAS_SAAS.includes(moneda as MonedaSaas)) return null;
  if (!CICLOS_SAAS.includes(ciclo as CicloSaas)) return null;
  return `sala_${tier}_${moneda}_${ciclo}`;
}

// Estado de suscripciones_saas: 'trial' | 'activa' | 'vencida' | 'cancelada' | 'pausada'.
export type EstadoSaas = 'trial' | 'activa' | 'vencida' | 'cancelada' | 'pausada';

/** Status autoritativo de Stripe → estado interno. past_due NO baja el acceso
 *  (gracia: el dunning de Stripe trabaja); el banner lo maneja payment_past_due. */
export function mapStripeStatusToEstado(status: string): EstadoSaas {
  switch (status) {
    case 'trialing':
      return 'trial';
    case 'active':
    case 'past_due':
      return 'activa';
    case 'paused':
      return 'pausada';
    case 'canceled':
      return 'cancelada';
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
      return 'vencida';
    default:
      return 'vencida';
  }
}

export type CicloFromInterval = CicloSaas | null;
export function cicloFromInterval(interval: string): CicloFromInterval {
  if (interval === 'month') return 'mensual';
  if (interval === 'year') return 'anual';
  return null;
}

// resolvePrice: lookup_key → price_id, con cache a nivel módulo (persiste
// mientras la instancia esté caliente). Los lookup_keys sobreviven test→live;
// los price_ids no → nunca se hardcodean.
const _priceCache = new Map<string, string>();
export async function resolvePriceId(stripe: Stripe, lookupKey: string): Promise<string> {
  const cached = _priceCache.get(lookupKey);
  if (cached) return cached;
  const res = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const price = res.data[0];
  if (!price) throw new Error(`No hay price activo en Stripe para lookup_key "${lookupKey}"`);
  _priceCache.set(lookupKey, price.id);
  return price.id;
}

/** Get-or-create del Stripe Customer del TENANT (el gym es el que paga el SaaS).
 *  Guarda el id en suscripciones_saas.stripe_customer_id. Trata los 'mock_*' del
 *  seed como "sin customer real". idempotencyKey por tenant evita duplicados
 *  reales; el match por metadata.tenant_id evita atar el customer de otro. */
export async function getOrCreateTenantCustomer(
  stripe: Stripe,
  admin: SupabaseClient,
  tenantId: string,
  ownerEmail: string | null
): Promise<string> {
  const { data: sub } = await admin
    .from('suscripciones_saas')
    .select('stripe_customer_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  const existing: string | null = sub?.stripe_customer_id ?? null;
  if (existing && !existing.startsWith('mock_')) return existing;

  // Anti-duplicados: si hay email, reusar un customer existente SOLO si su
  // metadata coincide con este tenant (no atar el de otro con el mismo email).
  if (ownerEmail) {
    const found = await stripe.customers.list({ email: ownerEmail, limit: 100 });
    const match = found.data.find(
      (c) => c.metadata?.app === 'sala' && c.metadata?.tenant_id === tenantId
    );
    if (match) {
      await persistCustomerId(admin, tenantId, match.id);
      return match.id;
    }
  }

  const customer = await stripe.customers.create(
    {
      email: ownerEmail ?? undefined,
      metadata: { app: 'sala', tenant_id: tenantId },
      preferred_locales: ['es']
    },
    { idempotencyKey: `sala_tenant_${tenantId}` }
  );

  await persistCustomerId(admin, tenantId, customer.id);
  return customer.id;
}

// Guarda el customer_id SOLO si ya existe la fila (update). Si el tenant aún no
// tiene fila en suscripciones_saas (primera suscripción), no la creamos acá: la
// crea el webhook en subscription.created con todos los datos. El idempotencyKey
// del customer garantiza que no se duplique entre el checkout y el webhook.
async function persistCustomerId(admin: SupabaseClient, tenantId: string, customerId: string): Promise<void> {
  await admin
    .from('suscripciones_saas')
    .update({ stripe_customer_id: customerId })
    .eq('tenant_id', tenantId);
}
