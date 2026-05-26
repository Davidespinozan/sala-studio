import type { Config } from 'tailwindcss';

/**
 * Tailwind config — solo utilities ortogonales (layout/spacing/fonts).
 *
 * D-017 (Fase A) eliminó los tokens de color brand (sala.primary, ek-mustard,
 * etc.) porque 0 componentes usaban Tailwind brand classes en sus className.
 * Toda la app consume color via CSS vars (--sala-primary, --ek-mustard) que
 * fluyen dinámicamente del tenant. Verificado con grep sistemático antes de
 * eliminar — ningún build se rompe.
 *
 * Si en el futuro algún componente necesita una utility brand, agregarla acá
 * con el patrón rgb(var(--sala-primary-rgb) / <alpha-value>) para que respete
 * el color dinámico del tenant.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        xs: '475px'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Space Grotesk', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Courier New', 'monospace']
      },
      fontVariantNumeric: {
        tabular: ['tabular-nums']
      },
      spacing: {
        'safe-top': 'env(safe-area-inset-top, 0px)',
        'safe-bottom': 'env(safe-area-inset-bottom, 0px)',
        'safe-left': 'env(safe-area-inset-left, 0px)',
        'safe-right': 'env(safe-area-inset-right, 0px)'
      }
    }
  },
  plugins: []
} satisfies Config;
