// Factory del cliente Stripe (Node/Netlify). A diferencia de HSC (Deno, que
// necesita createFetchHttpClient), en Node el SDK usa su http por defecto.
// apiVersion: omitida a propósito → usa el default del SDK v22 (igual que HSC).
import Stripe from 'stripe';
import { requireEnv } from './env';

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  _stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
    maxNetworkRetries: 2,
    appInfo: { name: 'SALA Studio' }
  });
  return _stripe;
}

export { Stripe };
