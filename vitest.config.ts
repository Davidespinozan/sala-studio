import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: true,
    // supabase.ts crea el cliente al importarse y exige una URL no vacía. Los
    // tests son unitarios (no llaman a Supabase), así que un valor dummy alcanza.
    // Sin esto, el job de CI (que no tiene .env.local) rompe al importar.
    env: {
      VITE_SUPABASE_URL: 'http://localhost:54321',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key-no-real'
    }
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
      '@public': path.resolve(__dirname, './src/public'),
      '@member': path.resolve(__dirname, './src/member'),
      '@admin': path.resolve(__dirname, './src/admin'),
      '@reception': path.resolve(__dirname, './src/reception'),
      '@styles': path.resolve(__dirname, './src/styles')
    }
  }
});
