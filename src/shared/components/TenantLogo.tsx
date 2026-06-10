import { useTenant } from '@shared/hooks/useTenant';

/**
 * Logo del TENANT (gimnasio cliente). Sistema de DOS PIEZAS:
 *   - variant='completo'  → branding.logo_url[_dark] (horizontal: símbolo + wordmark)
 *   - variant='isotipo'   → branding.isotipo_url (cuadrado: solo símbolo)
 *
 * Cada pieza tiene su CASCADA DE FALLBACK independiente. NO se mezclan
 * piezas entre tenant y SALA — si el tenant subió solo el logo
 * horizontal y no el isotipo, en login se ve el isotipo de SALA, no
 * el logo horizontal del tenant comprimido en un cuadrado:
 *
 *   variant='completo':
 *     1. tenant.branding.logo_url_dark
 *     2. tenant.branding.logo_url
 *     3. SalaLogo variant='completo' (fallback)
 *
 *   variant='isotipo':
 *     1. tenant.branding.isotipo_url
 *     2. SalaLogo variant='isotipo' (fallback)
 *
 * El admin del gimnasio sube sus piezas desde /admin/ajustes/marca
 * (AjustesMarca.tsx → bucket Storage "logos" → persistido en
 * tenants.branding.{logo_url,isotipo_url}). Hasta que lo haga, ve el
 * logo de SALA como placeholder.
 *
 * Aplica a los 5 lugares:
 *   Login                     → variant='isotipo'
 *   Member header             → variant='completo'
 *   Admin topbar (+pill ADMIN) → variant='completo'
 *   Recepción (+eyebrow)       → variant='completo'
 *   Landing público header    → variant='completo'
 */

interface TenantLogoProps {
  /** Pieza a mostrar. Default 'completo' (horizontal). */
  variant?: 'isotipo' | 'completo';
  /** Alto en píxeles del SVG si hay logo subido. Default 32 (header típico). */
  height?: number;
  /** font-size del primer token del nombre en el fallback de texto. Default 22. */
  fallbackFontSize?: number;
  /**
   * Si true, muestra el resto del nombre del tenant como eyebrow después
   * del primer token (ej. "SALA Studio" → "SALA" + eyebrow "STUDIO").
   * Solo aplica al fallback de texto del SalaLogo variant='completo'.
   * Default false (solo primer token).
   */
  showSuffix?: boolean;
}

export function TenantLogo({
  variant = 'completo',
  height = 32,
  fallbackFontSize = 22,
  showSuffix = false
}: TenantLogoProps) {
  const tenant = useTenant();
  const branding = (tenant.branding ?? {}) as Record<string, unknown>;

  // Cascada por pieza, sin mezclar
  const url =
    variant === 'isotipo'
      ? (typeof branding.isotipo_url === 'string' ? branding.isotipo_url : null)
      : typeof branding.logo_url_dark === 'string'
        ? branding.logo_url_dark
        : typeof branding.logo_url === 'string'
          ? (branding.logo_url as string)
          : null;

  if (url) {
    // Mismo sizing que SalaLogo: alto fijo + ancho auto, sin maxWidth ni
    // object-fit. Antes el maxWidth:200 + contain letterboxeaba los logos
    // anchos y los hacía aparecer más chicos que el default de SALA.
    return (
      <img
        src={url}
        alt={tenant.nombre}
        style={{
          height: `${height}px`,
          width: 'auto',
          display: 'block',
          borderRadius: variant === 'isotipo' ? '22%' : `${Math.max(6, Math.round(height * 0.16))}px`
        }}
      />
    );
  }

  // Fallback SIN logo subido: wordmark con el NOMBRE DEL TENANT (no la marca
  // SALA — eso confundía: un gym nuevo con sus colores veía el logo de SALA).
  const nombre = (tenant.nombre ?? '').trim() || 'Studio';
  const tokens = nombre.split(/\s+/).filter(Boolean);

  if (variant === 'isotipo') {
    const inicial = tokens.slice(0, 1).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
    return (
      <div
        style={{
          width: `${height}px`,
          height: `${height}px`,
          borderRadius: '22%',
          background: 'var(--sala-primary)',
          color: 'var(--sala-primary-text)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--ek-font-display)',
          fontSize: `${Math.round(height * 0.5)}px`,
          fontWeight: 700,
          letterSpacing: '-0.04em'
        }}
      >
        {inicial}
      </div>
    );
  }

  const first = tokens[0] ?? nombre;
  const rest = tokens.slice(1).join(' ');
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', minWidth: 0 }}>
      <span
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: `${fallbackFontSize}px`,
          fontWeight: 700,
          letterSpacing: '-0.04em',
          color: 'var(--sala-primary)',
          lineHeight: 1,
          whiteSpace: 'nowrap'
        }}
      >
        {first}
      </span>
      {showSuffix && rest && (
        <span className="ek-eyebrow" style={{ paddingTop: '4px', whiteSpace: 'nowrap' }}>
          {rest.toUpperCase()}
        </span>
      )}
    </div>
  );
}
