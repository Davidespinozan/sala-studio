import { useLandingConfig } from '@shared/hooks/useLandingConfig';
import { useTenant } from '@shared/hooks/useTenant';
import { PoweredBySala } from '@shared/components/PoweredBySala';

const ICON_SIZE = 18;

function IconInstagram() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  );
}

function IconTikTok() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.42a8.16 8.16 0 0 0 5 1.7V6.69h-2.07z" />
    </svg>
  );
}

function IconYouTube() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z" />
      <polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02" />
    </svg>
  );
}

function IconFacebook() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
    </svg>
  );
}

const REDES_ORDEN: Array<{ key: 'instagram' | 'tiktok' | 'youtube' | 'facebook'; label: string; Icon: () => JSX.Element }> = [
  { key: 'instagram', label: 'Instagram', Icon: IconInstagram },
  { key: 'tiktok', label: 'TikTok', Icon: IconTikTok },
  { key: 'youtube', label: 'YouTube', Icon: IconYouTube },
  { key: 'facebook', label: 'Facebook', Icon: IconFacebook }
];

export default function Footer() {
  const { footer } = useLandingConfig();
  const tenant = useTenant();

  // Brand text: primer token del nombre del tenant (ej. "SALA Studio" → "SALA").
  // Si está vacío, fallback a "SALA" para no romper visualmente.
  const brandShort = (tenant.nombre || 'SALA').split(/\s+/)[0];

  const branding = (tenant.branding ?? {}) as Record<string, unknown>;
  const logoUrl =
    typeof branding.logo_url_dark === 'string'
      ? branding.logo_url_dark
      : typeof branding.logo_url === 'string'
        ? (branding.logo_url as string)
        : null;

  const redesActivas = REDES_ORDEN.filter((r) => !!footer.redes[r.key]);
  const hayContacto = !!footer.email || !!footer.direccion;

  return (
    <footer
      style={{
        /* Banda full-bleed con el color principal (inmersivo). Rompe el
           contenedor 1200 para ir de borde a borde; el contenido se re-centra
           adentro y va en texto claro. */
        background: 'var(--grad-immersive)',
        borderTop: '1px solid rgba(255, 255, 255, 0.12)',
        marginTop: '48px',
        paddingTop: '40px',
        paddingBottom: '40px',
        width: '100vw',
        marginLeft: 'calc(50% - 50vw)'
      }}
    >
      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 24px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '32px',
          alignItems: 'start'
        }}
      >
        {/* Brand */}
        <div>
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={tenant.nombre}
              style={{ maxHeight: '36px', maxWidth: '180px', objectFit: 'contain', marginBottom: '12px', borderRadius: '6px' }}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '12px' }}>
              <span
                style={{
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: '20px',
                  fontWeight: 700,
                  letterSpacing: '-0.04em',
                  color: 'rgba(255, 255, 255, 0.96)'
                }}
              >
                {brandShort}
              </span>
              {footer.tagline && <span className="ek-eyebrow" style={{ color: 'rgba(255, 255, 255, 0.5)' }}>{footer.tagline}</span>}
            </div>
          )}
          {redesActivas.length > 0 && (
            <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
              {redesActivas.map(({ key, label, Icon }) => (
                <a
                  key={key}
                  href={footer.redes[key] ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  style={{
                    color: 'rgba(255, 255, 255, 0.7)',
                    display: 'inline-flex',
                    width: '36px',
                    height: '36px',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '50%',
                    border: '0.5px solid rgba(255, 255, 255, 0.25)',
                    transition: 'color 0.18s ease, border-color 0.18s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = 'rgba(255, 255, 255, 0.98)';
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.5)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = 'rgba(255, 255, 255, 0.7)';
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
                  }}
                >
                  <Icon />
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Contacto */}
        {hayContacto && (
          <div>
            <p className="ek-eyebrow" style={{ marginBottom: '12px', color: 'rgba(255, 255, 255, 0.55)' }}>CONTACTO</p>
            {footer.email && (
              <a
                href={`mailto:${footer.email}`}
                style={{
                  display: 'block',
                  fontSize: '13px',
                  color: 'rgba(255, 255, 255, 0.75)',
                  textDecoration: 'none',
                  marginBottom: '6px'
                }}
              >
                {footer.email}
              </a>
            )}
            {footer.direccion && (
              <p
                style={{
                  fontSize: '13px',
                  color: 'rgba(255, 255, 255, 0.75)',
                  margin: 0,
                  lineHeight: 1.5
                }}
              >
                {footer.direccion}
              </p>
            )}
          </div>
        )}

        {/* Navegación */}
        <div>
          <p className="ek-eyebrow" style={{ marginBottom: '12px', color: 'rgba(255, 255, 255, 0.55)' }}>NAVEGACIÓN</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <a
              href="/login"
              style={{ fontSize: '13px', color: 'rgba(255, 255, 255, 0.75)', textDecoration: 'none' }}
            >
              Iniciar sesión
            </a>
            <a
              href="#contacto"
              style={{ fontSize: '13px', color: 'rgba(255, 255, 255, 0.75)', textDecoration: 'none' }}
            >
              Contacto
            </a>
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: '32px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px'
        }}
      >
        <p
          style={{
            fontSize: '11px',
            color: 'rgba(255, 255, 255, 0.5)',
            margin: 0,
            letterSpacing: '0.04em'
          }}
        >
          © {new Date().getFullYear()} {tenant.nombre || 'SALA Studio'}. {footer.copyright}
        </p>
        <PoweredBySala align="left" tone="dark" />
      </div>
      </div>
    </footer>
  );
}
