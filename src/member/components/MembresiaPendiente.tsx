import { TenantLogo } from '@shared/components/TenantLogo';

/**
 * Pantalla para el miembro con status 'pendiente_pago': cuenta creada pero sin
 * plan activo. En vez de expulsarlo (lo hacía antes), queda logueado viendo este
 * estado read-only — recepción lo activa asignandole un plan.
 */
export function MembresiaPendiente({
  nombre,
  onCerrarSesion,
}: {
  nombre: string | null;
  onCerrarSesion: () => void;
}) {
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
        Tu cuenta está creada, pero todavía no tienes un plan activo. Acércate a
        recepción para activar tu membresía y empezar a reservar.
      </p>

      {/* TODO STRIPE: cuando haya pagos en línea, ofrecer acá un CTA "Elige tu
          plan / Pagar" → flujo de checkout (iniciarCheckout), para que el socio
          se active solo sin pasar por recepción. Ver STRIPE.md → touchpoints. */}
      <button onClick={onCerrarSesion} className="ek-cta ek-cta--secondary">
        Cerrar sesión
      </button>
    </div>
  );
}
