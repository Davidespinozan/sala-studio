import { useEffect, useMemo, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js';
import { backendPost } from '@shared/lib/backend';
import { useToast } from '@shared/hooks/useToast';

/**
 * Modal de SALA con el Embedded Checkout de Stripe (Flujo 2, Connect). El socio
 * paga su membresía SIN salir del sitio. Crea la sesión embedded vía
 * suscribir-membresia (ui_mode embedded_page sobre la cuenta conectada del gym)
 * y monta el formulario de Stripe acá adentro. Al completar el pago, onComplete
 * → onSuccess (el padre refresca / reactiva).
 */

const PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;

interface SesionResult {
  client_secret?: string;
  account?: string;
  activated?: boolean;
  reason?: string;
}

export function CheckoutModal({
  tierId,
  modo = 'compra',
  onClose,
  onSuccess
}: {
  tierId?: string;
  /** 'compra' → cobra el plan; 'tarjeta' → solo guarda una tarjeta (setup). */
  modo?: 'compra' | 'tarjeta';
  onClose: () => void;
  onSuccess: () => void;
}) {
  const toast = useToast();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const res = modo === 'tarjeta'
          ? await backendPost<SesionResult>('metodo-pago', { action: 'setup' })
          : await backendPost<SesionResult>('suscribir-membresia', { tier_id: tierId, embedded: true });
        if (cancelado) return;
        if (res.activated) {
          onSuccess(); // plan gratis → ya quedó activo
          return;
        }
        if (res.client_secret && res.account) {
          setClientSecret(res.client_secret);
          setAccount(res.account);
        } else if (res.reason === 'cobros_no_activos') {
          toast.error('Este gimnasio todavía no activó los cobros online. Acércate a recepción.');
          onClose();
        } else if (res.reason === 'sin_customer') {
          toast.error('Comprá un plan primero para poder guardar una tarjeta.');
          onClose();
        } else if (res.reason === 'tiene_mensualidad') {
          toast.error('Ya tenés una mensualidad activa. Cancelala antes de comprar un paquete.');
          onClose();
        } else {
          console.error('[CheckoutModal] respuesta inesperada:', res);
          toast.error('No pudimos abrir el pago. Probá de nuevo.');
          onClose();
        }
      } catch (e) {
        // El motivo real (401 'Sin perfil', 403, etc.) se perdía acá: al socio
        // le mostramos algo amable, pero sin esto quedaba INVISIBLE también para
        // nosotros y un fallo de permisos parecía "probá de nuevo".
        console.error('[CheckoutModal]', e);
        if (!cancelado) {
          toast.error('No pudimos abrir el pago. Probá de nuevo.');
          onClose();
        }
      } finally {
        if (!cancelado) setCargando(false);
      }
    })();
    return () => { cancelado = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierId, modo]);

  // Stripe.js inicializado SOBRE la cuenta conectada (direct charges).
  const stripePromise = useMemo(
    () => (PK && account ? loadStripe(PK, { stripeAccount: account }) : null),
    [account]
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(10, 15, 12, 0.6)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '480px',
          maxHeight: '92vh',
          overflowY: 'auto',
          background: 'var(--sala-surface)',
          borderRadius: '18px',
          padding: '20px',
          boxShadow: '0 24px 70px rgba(10, 15, 12, 0.5)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>
            {modo === 'tarjeta' ? 'AGREGAR TARJETA · STRIPE' : 'PAGO SEGURO · STRIPE'}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            style={{ width: 34, height: 34, borderRadius: '999px', border: '1px solid var(--sala-border)', background: 'var(--sala-bg)', color: 'var(--sala-text-primary)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        {!PK && (
          <p style={{ fontSize: 14, color: 'var(--sala-error)' }}>
            Los pagos online no están configurados todavía.
          </p>
        )}

        {PK && cargando && (
          <p style={{ fontSize: 14, color: 'var(--sala-text-tertiary)', padding: '24px 0', textAlign: 'center' }}>
            Preparando el pago…
          </p>
        )}

        {PK && clientSecret && stripePromise && (
          <EmbeddedCheckoutProvider
            stripe={stripePromise}
            options={{ clientSecret, onComplete: () => onSuccess() }}
          >
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        )}
      </div>
    </div>
  );
}
