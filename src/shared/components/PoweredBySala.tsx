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
}

export function PoweredBySala({ align = 'center' }: Props = {}) {
  const tenant = useTenant();
  const branding = (tenant.branding ?? {}) as Record<string, unknown>;

  if (branding.hide_powered_by === true) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'center' ? 'center' : 'flex-start',
        gap: '6px',
        padding: '12px 0',
        fontSize: '11px',
        color: 'var(--sala-text-tertiary)',
        letterSpacing: '0.02em',
        userSelect: 'none'
      }}
    >
      <span style={{ opacity: 0.55, display: 'inline-flex' }}>
        <SalaLogo variant="isotipo" height={17} />
      </span>
      <span>
        Powered by <strong style={{ fontWeight: 600 }}>SALA</strong>
      </span>
    </div>
  );
}
