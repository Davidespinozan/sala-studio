/**
 * Logo de marca SALA Studio. Dos modos:
 *   - SVG: `public/logo-sala.svg` (horizontal, verde sobre transparente,
 *     en el verde oficial #3D6B52). Se muestra si LOGO_SVG_DISPONIBLE
 *     está en true.
 *   - Fallback: wordmark de texto "SALA" + eyebrow "STUDIO" en
 *     --sala-primary. Mismo look que el wordmark hardcoded que había
 *     antes en Login / MemberLayout / AdminLayout — pero ahora
 *     centralizado.
 *
 * Cuando llegue el SVG oficial:
 *   1. Descargar a `public/logo-sala.svg`.
 *   2. Cambiar LOGO_SVG_DISPONIBLE a `true`.
 *   3. Listo. Los 3 lugares (Login, MemberLayout header, AdminLayout
 *      topbar mobile) muestran el SVG automáticamente.
 *
 * El componente NO va en lugares de branding del TENANT (PublicLayout
 * header con tenant.nombre, ni Sidebar admin que usa tenant.branding.logo_url).
 * Esos son del cliente, no del producto SALA.
 */

const LOGO_SVG_DISPONIBLE = true;
const LOGO_SRC = '/logo-sala.svg';

interface SalaLogoProps {
  /** Alto en píxeles cuando se usa el SVG. Default 32 (header típico). */
  height?: number;
  /** font-size del wordmark "SALA" del fallback. Default 22. */
  fallbackFontSize?: number;
  /** Mostrar el eyebrow "STUDIO" en el fallback. Default true. */
  showStudio?: boolean;
}

export function SalaLogo({
  height = 32,
  fallbackFontSize = 22,
  showStudio = true
}: SalaLogoProps) {
  if (LOGO_SVG_DISPONIBLE) {
    return (
      <img
        src={LOGO_SRC}
        alt="SALA Studio"
        style={{ height: `${height}px`, width: 'auto', display: 'block' }}
      />
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
      <span
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: `${fallbackFontSize}px`,
          fontWeight: 700,
          letterSpacing: '-0.04em',
          color: 'var(--sala-primary)',
          lineHeight: 1
        }}
      >
        SALA
      </span>
      {showStudio && (
        <span className="ek-eyebrow" style={{ paddingTop: '4px' }}>
          STUDIO
        </span>
      )}
    </div>
  );
}
