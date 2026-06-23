import { useEffect, useState } from 'react';
import { TenantLogo } from '@shared/components/TenantLogo';
import { useTenant } from '@shared/hooks/useTenant';
import { supabase } from '@shared/lib/supabase';
import { CheckoutModal } from '@shared/components/CheckoutModal';

/**
 * Socio con status 'pendiente_pago': cuenta creada, falta pagar. Abre directo el
 * modal de pago de SALA (Embedded Checkout) con su plan elegido. Si lo cierra,
 * queda esta pantalla con el botón para reabrirlo (o recepción como fallback).
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
  const [tierId, setTierId] = useState<string | null>(null);
  const [showCheckout, setShowCheckout] = useState(false);
  const [activando, setActivando] = useState(false);

  useEffect(() => {
    if (!tierSlug) return;
    let cancelado = false;
    (async () => {
      const { data } = await supabase
        .from('tiers')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('slug', tierSlug)
        .eq('activo', true)
        .maybeSingle();
      if (cancelado) return;
      if (data?.id) {
        setTierId(data.id);
        setShowCheckout(true); // directo al pago
      }
    })();
    return () => { cancelado = true; };
  }, [tierSlug, tenant.id]);

  function handlePaid() {
    setShowCheckout(false);
    setActivando(true);
    // El webhook activa la membresía (1-2s) → recargamos para entrar ya activo.
    setTimeout(() => window.location.reload(), 1800);
  }

  const wrap: React.CSSProperties = {
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '24px',
    background: 'var(--ek-bg)',
  };

  if (activando) {
    return (
      <div style={wrap}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '0 0 8px' }}>¡PAGO RECIBIDO!</p>
        <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: 20, fontWeight: 700, color: 'var(--ek-ink)', margin: 0 }}>
          Activando tu membresía…
        </p>
      </div>
    );
  }

  return (
    <>
      <div style={wrap}>
        <TenantLogo variant="completo" height={48} fallbackFontSize={30} showSuffix />
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '26px 0 8px' }}>CASI LISTO</p>
        <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.15, margin: '0 0 10px', color: 'var(--ek-ink)' }}>
          {nombre ? `Hola, ${nombre}` : 'Completá tu pago'}
        </h1>
        <p style={{ maxWidth: 380, fontSize: 14, color: 'var(--sala-text-secondary)', lineHeight: 1.55, margin: '0 0 22px' }}>
          Pagá tu plan para activar tu membresía y empezar a reservar.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 300 }}>
          {tierId && (
            <button onClick={() => setShowCheckout(true)} className="ek-cta">
              Pagar mi plan
            </button>
          )}
          <button onClick={onCerrarSesion} className="ek-cta ek-cta--secondary">
            Cerrar sesión
          </button>
        </div>
      </div>

      {showCheckout && tierId && (
        <CheckoutModal tierId={tierId} onClose={() => setShowCheckout(false)} onSuccess={handlePaid} />
      )}
    </>
  );
}
