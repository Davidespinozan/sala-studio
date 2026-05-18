import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        xs: '475px'
      },
      colors: {
        // SALA design tokens — paleta Salvia Light
        sala: {
          bg: '#FAFAF7',
          surface: '#FFFFFF',
          border: '#E8E6E0',
          'border-strong': '#D4D0C8',

          primary: '#3D6B52',
          'primary-hover': '#2F5440',
          'primary-light': '#E8F0EB',

          accent: '#E8654A',
          'accent-hover': '#D54E33',
          'accent-light': '#FCE8E2',

          'text-primary': '#1A1F1C',
          'text-secondary': '#6B7B73',
          'text-tertiary': '#9CA8A1',
          'text-on-primary': '#FFFFFF',
          'text-on-accent': '#FFFFFF',

          success: '#3D6B52',
          'success-bg': '#E8F0EB',
          warning: '#C8941F',
          'warning-bg': '#FAF2DC',
          error: '#C44A35',
          'error-bg': '#FCE5DF'
        },

        // Legacy ek-* tokens — alias hacia Salvia Light (backward compat)
        'ek-cream':         '#FAFAF7',
        'ek-cream-warm':    '#FFFFFF',
        'ek-cream-deep':    '#F2EFE8',
        'ek-black':         '#1A1F1C',
        'ek-black-soft':    '#6B7B73',
        'ek-mustard':       '#3D6B52',
        'ek-mustard-deep':  '#2F5440',
        'ek-success':       '#3D6B52',
        'ek-danger':        '#C44A35',
        'ek-warning':       '#C8941F',
        'ek-info':          '#4A7BA0'
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
