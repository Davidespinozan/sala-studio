import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        xs: '475px'
      },
      colors: {
        // EKKO tokens accesibles desde Tailwind (también en CSS vars)
        'ek-cream': '#F5F1E8',
        'ek-cream-warm': '#EFEAD8',
        'ek-cream-deep': '#E8E1CC',
        'ek-black': '#0A0A0A',
        'ek-black-soft': '#1A1A1A',
        'ek-mustard': '#D4A93C',
        'ek-mustard-deep': '#8C6E1F',
        'ek-success': '#2E7D5B',
        'ek-danger': '#B23A3A',
        'ek-warning': '#C68A1E',
        'ek-info': '#2C5F8E'
      },
      fontFamily: {
        sans: ['Geist', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'JetBrains Mono', 'monospace']
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
