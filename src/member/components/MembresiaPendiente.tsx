import { useState } from 'react';
import { TenantLogo } from '@shared/components/TenantLogo';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { supabase } from '@shared/lib/supabase';
import { iniciarCheckout } from '@shared/lib/checkout';

/**
 * Pantalla para el miembro con status 'pendiente_pago': cuenta creada pero sin
 * plan activo. Ofrece pagar online (Stripe) para activarse solo; si el gym no
 * tiene cobros online, el fallback es recepción.
 */
export function MembresiaPendiente({
  nombre,
  tierSlug,
  onCerrarSesion,
}: {
  nombre: string | null;
  tierSlug?: string | null;
  onCerrarSesion: () => void;
}) {
  const tenant = useTenant();
  const toast = useToast();
  const [pagando, setPagando] = useState(false);

  async function pagar() {
    if (!tierSlug) {
      toast.error('No encontramos tu plan. Acércate a recepción para activarlo.');
      return;
    }
    setPagando(true);
    try {
      const { data: tier } = await supabase
        .from('tiers')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('slug', tierSlug)
        .eq('activo', true)
        .maybeSingle();
      if (!tier?.id) {
        toast.error('No encontramos tu plan. Acércate a recepción.');
        return;
      }
      const res = await iniciarCheckout(tier.id);
      if (res.url) return; // redirigiendo a Stripe Checkout
      if (res.activated) {
        window.location.reload();
        return;
      }
      if (res.reason === 'cobros_no_activos') {
        toast.error('Tu gym todavía no activó los cobros online. Acércate a recepción.');
      } else {
        toast.error('No pudimos iniciar el pago. Probá de nuevo.');
      }
    } catch {
      toast.error('No pudimos iniciar el pago. Probá de nuevo.');
    } finally {
      setPagando(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '24px',
        background: 'var(--ek-bg)',
      }}
    >
      <TenantLogo variant="completo" height={48} fallbackFontSize={30} showSuffix />

      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '26px 0 8px' }}>
        MEMBRESÍA PENDIENTE
      </p>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '24px',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          lineHeight: 1.15,
          margin: '0 0 10px',
          color: 'var(--ek-ink)',
        }}
      >
        {nombre ? `Hola, ${nombre}` : 'Tu membresía está pendiente'}
      </h1>
      <p style={{ maxWidth: '380px', fontSize: '14px', color: 'var(--sala-text-secondary)', lineHeight: 1.55, margin: '0 0 22px' }}>
        Tu cuenta está creada. Pagá tu plan para activarte y empezar a reservar.
        Si preferís, también podés activarlo en recepción.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '300px' }}>
        <button onClick={pagar} disabled={pagando} className="ek-cta" style={{ opacity: pagando ? 0.7 : 1 }}>
          {pagando ? 'Abriendo el pago…' : 'Pagar y activar mi plan'}
        </button>
        <button onClick={onCerrarSesion} className="ek-cta ek-cta--secondary" disabled={pagando}>
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
