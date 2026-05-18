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
    css: true
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
