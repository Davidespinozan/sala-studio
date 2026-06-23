// ════════════════════════════════════════════════════════════════════════════
// Helpers del Flujo 2 (gym → socios) con Stripe Connect (direct charges).
// El gym es la cuenta conectada (merchant); el socio le paga directo; SALA toma
// un application_fee (hoy 0%). El customer del socio vive EN la cuenta conectada
// (direct charges → todo ocurre sobre `stripeAccount`).
// ════════════════════════════════════════════════════════════════════════════
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Stripe } from './stripe';

/** Get-or-create del Stripe Customer del SOCIO en la cuenta conectada del gym.
 *  Guarda el id en usuarios.stripe_customer_id. idempotencyKey por usuario evita
 *  duplicados; el match por metadata.usuario_id evita atar el de otro. */
export async function getOrCreateSocioCustomer(
  stripe: Stripe,
  admin: SupabaseClient,
  socio: { id: string; email: string | null; stripe_customer_id: string | null },
  stripeAccount: string
): Promise<string> {
  const existing = socio.stripe_customer_id;
  if (existing && !existing.startsWith('mock_')) return existing;

  if (socio.email) {
    const found = await stripe.customers.list(
      { email: socio.email, limit: 100 },
      { stripeAccount }
    );
    const match = found.data.find((c) => c.metadata?.app === 'sala' && c.metadata?.usuario_id === socio.id);
    if (match) {
      await admin.from('usuarios').update({ stripe_customer_id: match.id }).eq('id', socio.id);
      return match.id;
    }
  }

  const customer = await stripe.customers.create(
    {
      email: socio.email ?? undefined,
      metadata: { app: 'sala', usuario_id: socio.id },
      preferred_locales: ['es']
    },
    { idempotencyKey: `sala_socio_${socio.id}`, stripeAccount }
  );

  await admin.from('usuarios').update({ stripe_customer_id: customer.id }).eq('id', socio.id);
  return customer.id;
}
