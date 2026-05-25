import { useTenant } from '@shared/hooks/useTenant';

/**
 * Logo del TENANT (gimnasio cliente). Consume `tenant.branding.logo_url`
 * (con preferencia por `logo_url_dark` si existe). Si no hay logo subido,
 * fallback al nombre del gimnasio en texto.
 *
 * NO usa el logo de SALA producto. La marca SALA no debe aparecer en
 * lugares de "logo del tenant" (login, headers member/admin/recepción,
 * landing público) — esos pertenecen al gimnasio.
 *
 * El admin del gimnasio sube su logo desde `/admin/ajustes/marca`
 * (AjustesMarca.tsx → bucket Storage "logos" → persistido en
 * `tenants.branding.logo_url[_dark]`).
 *
 * NOTA DE CONTRASTE — el fallback de texto usa `var(--ek-mustard)`, que
 * el TenantProvider sobrescribe con `branding.color_primary` del tenant.
 * Si un tenant configura un color custom muy claro (ej. amarillo pastel)
 * el texto pierde contraste sobre fondos claros (header crema/blanco).
 * Esto NO se resuelve acá — el editor de marca (AjustesMarca) debería
 * validar contraste WCAG mínimo del color elegido y advertir al admin
 * antes de guardar. Pendiente como mejora de UX del editor.
 */

interface TenantLogoProps {
  /** Alto en píxeles del SVG si hay logo subido. Default 32 (header típico). */
  height?: number;
  /** font-size del primer token del nombre en el fallback. Default 22. */
  fallbackFontSize?: number;
  /**
   * Si true, muestra el resto del nombre del tenant como eyebrow después
   * del primer token (ej. "SALA Studio" → "SALA" + eyebrow "STUDIO").
   * Default false (solo primer token).
   */
  showSuffix?: boolean;
}

export function TenantLogo({
  height = 32,
  fallbackFontSize = 22,
  showSuffix = false
}: TenantLogoProps) {
  const tenant = useTenant();
  const branding = (tenant.branding ?? {}) as Record<string, unknown>;
  const logoUrl =
    typeof branding.logo_url_dark === 'string'
      ? branding.logo_url_dark
      : typeof branding.logo_url === 'string'
        ? (branding.logo_url as string)
        : null;

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={tenant.nombre}
        style={{
          height: `${height}px`,
          width: 'auto',
          objectFit: 'contain',
          maxWidth: '200px',
          display: 'block'
        }}
      />
    );
  }

  // Fallback: texto del nombre del tenant. Primer token destacado,
  // resto como eyebrow opcional.
  const tokens = (tenant.nombre || '').split(/\s+/).filter(Boolean);
  const head = tokens[0] || 'Gym';
  const suffix =
    showSuffix && tokens.length > 1
      ? tokens.slice(1).join(' ').toUpperCase()
      : null;

  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
      <span
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: `${fallbackFontSize}px`,
          fontWeight: 700,
          letterSpacing: '-0.04em',
          color: 'var(--ek-mustard)', // ← mapeado a branding.color_primary del tenant
          lineHeight: 1
        }}
      >
        {head}
      </span>
      {suffix && (
        <span className="ek-eyebrow" style={{ paddingTop: '4px' }}>
          {suffix}
        </span>
      )}
    </div>
  );
}
