import { useTenant } from '@shared/hooks/useTenant';
import { SalaLogo } from '@shared/components/SalaLogo';

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
          display: 'block'
        }}
      />
    );
  }

  // Fallback: SalaLogo con la MISMA variant (no mezclar piezas).
  return (
    <SalaLogo
      variant={variant}
      height={height}
      fallbackFontSize={fallbackFontSize}
      showStudio={showSuffix}
    />
  );
}
