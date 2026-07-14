import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';
import { devFunctionsPlugin } from './scripts/devFunctionsPlugin';

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';
  const hasSentryConfig =
    process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT;

  return {
    plugins: [
      react(),
      // Dev-only: sirve las Netlify Functions dentro de `npm run dev`.
      devFunctionsPlugin(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
        manifest: {
          name: 'SALA Studio',
          short_name: 'SALA',
          description: 'Reserva clases, gestiona membresías, opera tu gimnasio',
          lang: 'es',
          // Paleta Salvia Light real del proyecto (src/styles/sala.css):
          //   theme_color  = --sala-primary (chrome del browser / status bar)
          //   background_color = --sala-bg (splash; matchea lo que pinta la app)
          theme_color: '#3D6B52',
          background_color: '#FAFAF7',
          display: 'standalone',
          orientation: 'portrait',
          scope: '/',
          start_url: '/',
          icons: [
            {
              src: '/icons/icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any maskable'
            },
            {
              src: '/icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable'
            }
          ]
        },
        workbox: {
          // Los handlers de push viven en public/push-sw.js y se IMPORTAN dentro
          // del SW de Workbox: dos service workers peleando por el mismo scope es
          // una fuente clásica de bugs.
          importScripts: ['push-sw.js'],
          cleanupOutdatedCaches: true,
          navigateFallbackDenylist: [/^\/api/, /^\/.netlify/],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
              handler: 'NetworkOnly'
            }
          ]
        }
      }),
      isProduction && hasSentryConfig && sentryVitePlugin({
        org: process.env.SENTRY_ORG!,
        project: process.env.SENTRY_PROJECT!,
        authToken: process.env.SENTRY_AUTH_TOKEN!
      })
    ].filter(Boolean),
    resolve: {
      // Garantiza una sola copia de React: sin esto, el pre-bundling de Vite
      // en dev puede servir dos instancias (chunks con ?v= distintos) y
      // useContext crashea con "Cannot read properties of null".
      dedupe: ['react', 'react-dom', 'react-router-dom'],
      alias: {
        '@shared': path.resolve(__dirname, './src/shared'),
        '@public': path.resolve(__dirname, './src/public'),
        '@member': path.resolve(__dirname, './src/member'),
        '@admin': path.resolve(__dirname, './src/admin'),
        '@reception': path.resolve(__dirname, './src/reception'),
        '@styles': path.resolve(__dirname, './src/styles')
      }
    },
    optimizeDeps: {
      // Pre-bundlea React de forma consistente para que todos los chunks
      // compartan la misma instancia.
      include: ['react', 'react-dom', 'react-router-dom']
    },
    build: {
      outDir: 'dist',
      sourcemap: isProduction,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-supabase': ['@supabase/supabase-js'],
            'vendor-sentry': ['@sentry/react']
          }
        }
      }
    },
    server: {
      port: 5173,
      host: true
    }
  };
});
