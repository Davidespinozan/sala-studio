/**
 * Logo de marca SALA Studio en dos variantes:
 *   - 'completo': logo horizontal (símbolo + wordmark) en /logo-sala.svg.
 *     Para headers horizontales con espacio para wordmark.
 *   - 'isotipo': solo el símbolo cuadrado en /isotipo-sala.svg.
 *     Para espacios chicos/cuadrados/centrados (login, ícono).
 *
 * Verde oficial #3D6B52 sobre fondo transparente en ambos casos.
 *
 * Fallback si LOGO_SVG_DISPONIBLE=false: wordmark de texto "SALA" +
 * eyebrow "STUDIO", dibujado con la tipografía de marca. Nítido a cualquier
 * densidad, tintable y sin peso de archivo.
 *
 * NOTA (jun-2026): los SVG en public/ (logo-sala.svg, isotipo-sala.svg) NO son
 * vectoriales — son un PNG raster con una SOMBRA gris bakeada, envuelto en
 * <svg>. Eso causaba pixelado en pantallas retina + un halo/contorno gris en
 * cualquier fondo. Hasta tener un logo vectorial limpio de verdad, usamos el
 * fallback de texto (LOGO_SVG_DISPONIBLE=false). Para volver al archivo,
 * reemplazá public/logo-sala.svg por un SVG vectorial real y poné el flag en true.
 *
 * Usado como FALLBACK del TenantLogo cuando el tenant no subió su
 * propia versión de la pieza. La aplicación NO usa SalaLogo
 * directamente — siempre va a través de TenantLogo.
 */

const LOGO_SVG_DISPONIBLE = false;
const LOGO_COMPLETO_SRC = '/logo-sala.svg';
const LOGO_ISOTIPO_SRC = '/isotipo-sala.svg';

interface SalaLogoProps {
  /** Variante: 'completo' (horizontal) o 'isotipo' (cuadrado). Default 'completo'. */
  variant?: 'isotipo' | 'completo';
  /** Alto en píxeles cuando se usa el SVG. Default 32 (header típico). */
  height?: number;
  /** font-size del wordmark "SALA" del fallback. Default 22. */
  fallbackFontSize?: number;
  /** Mostrar el eyebrow "STUDIO" en el fallback de texto (solo aplica a variant='completo'). Default true. */
  showStudio?: boolean;
}

export function SalaLogo({
  variant = 'completo',
  height = 32,
  fallbackFontSize = 22,
  showStudio = true
}: SalaLogoProps) {
  if (LOGO_SVG_DISPONIBLE) {
    const src = variant === 'isotipo' ? LOGO_ISOTIPO_SRC : LOGO_COMPLETO_SRC;
    return (
      <img
        src={src}
        alt="SALA Studio"
        style={{ height: `${height}px`, width: 'auto', display: 'block' }}
      />
    );
  }

  // Fallback de texto. Para variant='isotipo' solo mostramos "S" (la inicial).
  if (variant === 'isotipo') {
    return (
      <div
        style={{
          width: `${height}px`,
          height: `${height}px`,
          borderRadius: '12%',
          background: 'var(--sala-primary)',
          color: 'var(--sala-bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--ek-font-display)',
          fontSize: `${Math.round(height * 0.55)}px`,
          fontWeight: 700,
          letterSpacing: '-0.04em'
        }}
      >
        S
      </div>
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
