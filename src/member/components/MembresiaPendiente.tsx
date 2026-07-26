import { useEffect, useState } from 'react';
import { TenantLogo } from '@shared/components/TenantLogo';
import { useTenant } from '@shared/hooks/useTenant';
import { useLandingConfig } from '@shared/hooks/useLandingConfig';
import { socioPuedePagarEnApp } from '@shared/lib/cobrosDelGym';
import { autoservicioActivo } from '@shared/lib/cobrosConfig';
import { supabase } from '@shared/lib/supabase';
import { CheckoutModal } from '@shared/components/CheckoutModal';

/**
 * Socio con status 'pendiente_pago': cuenta creada, falta pagar.
 *
 * Si el gym COBRA ONLINE (terminó su onboarding de Connect), abre directo el
 * Embedded Checkout con su plan; si lo cierra, queda el botón para reabrirlo.
 *
 * Si el gym NO cobra online, esta pantalla NO puede pedir plata: antes igual
 * abría el checkout y el socio comía un "acércate a recepción" apenas entraba,
 * volvía a esta pantalla que le insistía "Pagá tu plan", apretaba el botón, y
 * otra vez lo mismo — un callejón sin salida. Ahora se le dice la verdad (su
 * cuenta está lista, el pago lo coordina con el gym) y se le da el WhatsApp.
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
  const { whatsappUrl } = useLandingConfig();
  const cobraOnline = socioPuedePagarEnApp(tenant);
  // Sin cobro online: si el gym cobra en recepción (autoservicio off) el mensaje
  // es directo; si es Connect en trámite, "coordina con el gym".
  const autoservicio = autoservicioActivo(tenant.config as Record<string, unknown> | null);
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
        // Solo abrimos el pago si el gym puede cobrar. Si no, el modal se abriría
        // para morir en "acércate a recepción".
        if (cobraOnline) setShowCheckout(true);
      }
    })();
    return () => { cancelado = true; };
  }, [tierSlug, tenant.id, cobraOnline]);

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
          {nombre ? `Hola, ${nombre}` : cobraOnline ? 'Completa tu pago' : 'Tu cuenta está lista'}
        </h1>
        <p style={{ maxWidth: 380, fontSize: 14, color: 'var(--sala-text-secondary)', lineHeight: 1.55, margin: '0 0 22px' }}>
          {cobraOnline
            ? 'Paga tu plan para activar tu membresía y empezar a reservar.'
            : autoservicio
              ? `Tu cuenta ya está creada. Coordina el pago con ${tenant.nombre} y activan tu membresía para que puedas reservar.`
              : `Tu cuenta ya está creada. Paga tu plan en recepción y activan tu membresía para que puedas reservar.`}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 300 }}>
          {cobraOnline && tierId && (
            <button onClick={() => setShowCheckout(true)} className="ek-cta">
              Pagar mi plan
            </button>
          )}
          {!cobraOnline && whatsappUrl() && (
            <a
              href={whatsappUrl() as string}
              target="_blank"
              rel="noopener noreferrer"
              className="ek-cta"
              style={{ textDecoration: 'none' }}
            >
              Escríbele a {tenant.nombre}
            </a>
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
