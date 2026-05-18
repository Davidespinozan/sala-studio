import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';
  const hasSentryConfig =
    process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT;

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
        manifest: {
          name: 'EKKO Studio',
          short_name: 'EKKO',
          description: 'Tu espacio para crear contenido profesional',
          theme_color: '#0A0A0A',
          background_color: '#F5F1E8',
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
      alias: {
        '@shared': path.resolve(__dirname, './src/shared'),
        '@public': path.resolve(__dirname, './src/public'),
        '@member': path.resolve(__dirname, './src/member'),
        '@admin': path.resolve(__dirname, './src/admin'),
        '@reception': path.resolve(__dirname, './src/reception'),
        '@styles': path.resolve(__dirname, './src/styles')
      }
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
