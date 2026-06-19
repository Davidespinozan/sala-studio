import { defineConfig, devices } from '@playwright/test';

// Si E2E_BASE_URL apunta a algo externo (p.ej. prod), no levantamos server.
// En CI servimos el BUILD con `vite preview` (prueba el código del push, no prod).
// En local, `vite dev`.
const externo = !!process.env.E2E_BASE_URL;
const ci = !!process.env.CI;
const localURL = ci ? 'http://localhost:4173' : 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  workers: ci ? 1 : undefined,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL: process.env.E2E_BASE_URL || localURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] }
    }
  ],
  webServer: externo
    ? undefined
    : {
        command: ci ? 'npm run preview -- --port 4173' : 'npm run dev',
        url: localURL,
        reuseExistingServer: !ci,
        timeout: 120_000
      }
});
