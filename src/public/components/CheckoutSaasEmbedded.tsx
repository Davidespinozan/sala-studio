import { useEffect, useMemo, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js';
import { backendPost } from '@shared/lib/backend';

/**
 * Embedded Checkout del SaaS (Flujo 1, alta del gym): el dueño carga su tarjeta
 * en SALA, con los 7 días de prueba. Cuenta PLATAFORMA (no Connect) → loadStripe
 * sin stripeAccount. Requiere estar logueado (el token va en backendPost).
 */

const PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;

interface SesionResult {
  client_secret?: string;
  url?: string;
  reason?: string;
}

export function CheckoutSaasEmbedded({
  tier,
  moneda,
  // El ciclo lo ELIGE el cliente en la landing. Estaba clavado en 'mensual',
  // asi que el toggle "Anual · 2 MESES GRATIS" cobraba el precio mensual: se
  // prometia un descuento imposible de comprar.
  ciclo = 'mensual',
  onComplete,
  onError
}: {
  tier: string;
  moneda: string;
  ciclo?: 'mensual' | 'anual';
  onComplete: () => void;
  onError: (msg: string) => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const res = await backendPost<SesionResult>('suscribir-saas', {
          tier,
          moneda,
          ciclo,
          embedded: true
        });
        if (cancelado) return;
        if (res.client_secret) {
          setClientSecret(res.client_secret);
        } else {
          onError(res.reason === 'stripe_pendiente' ? 'Estamos conectando Stripe. Probá en un rato.' : 'No pudimos abrir el pago.');
        }
      } catch {
        if (!cancelado) onError('No pudimos abrir el pago. Probá de nuevo.');
      } finally {
        if (!cancelado) setCargando(false);
      }
    })();
    return () => { cancelado = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, moneda, ciclo]);

  const stripePromise = useMemo(() => (PK ? loadStripe(PK) : null), []);

  if (!PK) {
    return <p style={{ fontSize: '14px', color: 'var(--sala-error)' }}>Los pagos online no están configurados todavía.</p>;
  }
  if (cargando) {
    return <p style={{ fontSize: '14px', color: 'var(--sala-text-tertiary)', padding: '24px 0', textAlign: 'center' }}>Preparando el pago seguro…</p>;
  }
  if (!clientSecret || !stripePromise) return null;

  return (
    <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret, onComplete }}>
      <EmbeddedCheckout />
    </EmbeddedCheckoutProvider>
  );
}
