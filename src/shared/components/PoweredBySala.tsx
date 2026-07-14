import { useTenant } from '@shared/hooks/useTenant';
import { SalaLogo } from '@shared/components/SalaLogo';

/**
 * Footer "Powered by SALA" discreto, visible al pie de cada vista.
 *
 * Composición: isotipo chico de SALA (14px, opacidad reducida) + texto
 * tenue "Powered by SALA". No es un link — atribución pasiva, no compite
 * con la marca del tenant.
 *
 * Flag: branding.hide_powered_by === true → return null. Default visible.
 * Opción A (flag manual). Cuando exista Stripe + suscripciones SaaS reales,
 * conectar a plan (premium oculta automáticamente) — D-019 en DECISIONS.
 */

interface Props {
  /** Alineación dentro de su contenedor. Default 'center'. */
  align?: 'center' | 'left';
  /**
   * Tono según el fondo donde se monta el footer.
   *   - 'light' (default): fondo claro/cremita. Color tenue grayscale.
   *   - 'dark': fondo oscuro (ej. sidebar admin con --sala-primary-darkest).
   *     Color light apagado con suficiente contraste (≥4.5:1 sobre los 4
   *     primarios validados en scripts/validate-sidebar-contrast.mjs).
   */
  tone?: 'light' | 'dark';
  /** Suma la atribución a STRYV (la implementación). Solo en la web pública. */
  conStryv?: boolean;
}

export function PoweredBySala({ align = 'center', tone = 'light', conStryv = false }: Props = {}) {
  const tenant = useTenant();
  const branding = (tenant.branding ?? {}) as Record<string, unknown>;

  if (branding.hide_powered_by === true) return null;

  const isDark = tone === 'dark';
  const colorBase = isDark ? 'rgba(255, 255, 255, 0.60)' : 'var(--sala-text-tertiary)';
  const linkStyle = { color: 'inherit', textDecoration: 'none', fontWeight: 600 } as const;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'center' ? 'center' : 'flex-start',
        gap: '6px',
        padding: '12px 0',
        fontSize: '11px',
        color: colorBase,
        letterSpacing: '0.02em'
      }}
    >
      {/* Isotipo a opacidad plena: bajarla lo dejaba lavado/"sucio" sobre el
          fondo. La discreción de la atribución la da el tamaño (17px) y el tono
          tenue del texto, no un logo desteñido. */}
      <span style={{ display: 'inline-flex' }}>
        <SalaLogo variant="isotipo" height={17} />
      </span>
      <span>
        Powered by{' '}
        <a
          href="https://salastudio.app/para-gimnasios"
          target="_blank"
          rel="noopener noreferrer"
          title="Conoce SALA — crea tu propio gym"
          style={linkStyle}
        >
          SALA
        </a>
        {/* STRYV solo en la web PÚBLICA del gym: adentro de la app la gente ya es
            cliente, ahí una marca de implementación no le habla a nadie. */}
        {conStryv && (
          <>
            {' · por '}
            <a
              href="https://stryvstudio.com"
              target="_blank"
              rel="noopener noreferrer"
              title="STRYV — implementación digital"
              style={linkStyle}
            >
              STRYV
            </a>
          </>
        )}
      </span>
    </div>
  );
}
