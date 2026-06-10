/**
 * Tipografías curadas para la marca del tenant.
 *
 * El dueño elige una fuente para TÍTULOS (display) y otra para TEXTO (body)
 * desde Ajustes › Marca. Todas son Google Fonts validadas (legibles, premium).
 * En runtime, applyTypography() (TenantProvider) inyecta el <link> de Google
 * Fonts y pisa --ek-font-display / --ek-font-body.
 *
 * Cada entrada:
 *   key    → identificador persistido en branding.font_display / font_body
 *   label  → nombre visible en el selector
 *   stack  → valor CSS de font-family (con fallback de sistema)
 *   google → fragmento "Family:wght@..." para el URL de fonts.googleapis.com
 *   kind   → sugerencia de uso (no restrictiva): se puede usar cualquiera para
 *            títulos o texto.
 */
export interface FontOption {
  key: string;
  label: string;
  stack: string;
  google: string;
  kind: 'sans' | 'display' | 'serif';
}

export const FONT_OPTIONS: FontOption[] = [
  {
    key: 'space-grotesk',
    label: 'Space Grotesk',
    stack: "'Space Grotesk', system-ui, sans-serif",
    google: 'Space+Grotesk:wght@400;500;600;700',
    kind: 'display'
  },
  {
    key: 'inter',
    label: 'Inter',
    stack: "'Inter', system-ui, sans-serif",
    google: 'Inter:wght@400;500;600;700',
    kind: 'sans'
  },
  {
    key: 'sora',
    label: 'Sora',
    stack: "'Sora', system-ui, sans-serif",
    google: 'Sora:wght@400;500;600;700',
    kind: 'display'
  },
  {
    key: 'manrope',
    label: 'Manrope',
    stack: "'Manrope', system-ui, sans-serif",
    google: 'Manrope:wght@400;500;600;700',
    kind: 'sans'
  },
  {
    key: 'dm-sans',
    label: 'DM Sans',
    stack: "'DM Sans', system-ui, sans-serif",
    google: 'DM+Sans:wght@400;500;600;700',
    kind: 'sans'
  },
  {
    key: 'outfit',
    label: 'Outfit',
    stack: "'Outfit', system-ui, sans-serif",
    google: 'Outfit:wght@400;500;600;700',
    kind: 'display'
  },
  {
    key: 'poppins',
    label: 'Poppins',
    stack: "'Poppins', system-ui, sans-serif",
    google: 'Poppins:wght@400;500;600;700',
    kind: 'sans'
  },
  {
    key: 'work-sans',
    label: 'Work Sans',
    stack: "'Work Sans', system-ui, sans-serif",
    google: 'Work+Sans:wght@400;500;600;700',
    kind: 'sans'
  },
  {
    key: 'figtree',
    label: 'Figtree',
    stack: "'Figtree', system-ui, sans-serif",
    google: 'Figtree:wght@400;500;600;700',
    kind: 'sans'
  },
  {
    key: 'bricolage-grotesque',
    label: 'Bricolage Grotesque',
    stack: "'Bricolage Grotesque', system-ui, sans-serif",
    google: 'Bricolage+Grotesque:wght@400;500;600;700',
    kind: 'display'
  },
  {
    key: 'fraunces',
    label: 'Fraunces (serif)',
    stack: "'Fraunces', Georgia, serif",
    google: 'Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700',
    kind: 'serif'
  },
  {
    key: 'playfair-display',
    label: 'Playfair Display (serif)',
    stack: "'Playfair Display', Georgia, serif",
    google: 'Playfair+Display:wght@400;500;600;700',
    kind: 'serif'
  },
  {
    key: 'dm-serif-display',
    label: 'DM Serif Display (serif)',
    stack: "'DM Serif Display', Georgia, serif",
    google: 'DM+Serif+Display:ital@0;1',
    kind: 'serif'
  }
];

const FONT_BY_KEY = new Map(FONT_OPTIONS.map((f) => [f.key, f]));

export function getFont(key: string | null | undefined): FontOption | null {
  if (!key) return null;
  return FONT_BY_KEY.get(key) ?? null;
}

/**
 * Escala global de tamaño de letra. Multiplica los tamaños tipográficos base
 * (vía --sala-font-scale y calc() en sala.css).
 */
export type FontScale = 'compacto' | 'normal' | 'grande';

export const FONT_SCALES: { key: FontScale; label: string; value: number }[] = [
  { key: 'compacto', label: 'Compacto', value: 0.92 },
  { key: 'normal', label: 'Normal', value: 1 },
  { key: 'grande', label: 'Grande', value: 1.1 }
];

export function getScaleValue(key: string | null | undefined): number {
  const found = FONT_SCALES.find((s) => s.key === key);
  return found ? found.value : 1;
}

/**
 * Construye el href de Google Fonts (css2) para las familias dadas. Dedup por
 * fragmento. Devuelve null si no hay ninguna.
 */
export function buildFontsHref(googleSpecs: (string | null | undefined)[]): string | null {
  const uniq = Array.from(new Set(googleSpecs.filter((g): g is string => !!g)));
  if (uniq.length === 0) return null;
  const families = uniq.map((g) => `family=${g}`).join('&');
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}
