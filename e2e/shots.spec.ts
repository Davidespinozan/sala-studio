import { test } from '@playwright/test';
import fs from 'fs';

/**
 * Generador de capturas para la landing de SALA (public/shots/*.png).
 * Entra al demo (healthyspace) por cada vista y captura las pantallas clave.
 * Requiere VITE_DEMO_ENABLED=true en el dev server:
 *   VITE_DEMO_ENABLED=true npx playwright test e2e/shots.spec.ts --project=chromium
 * NO es parte de la suite de CI (mutar el demo crea usuarios anónimos efímeros).
 */

const DIR = 'public/shots';
fs.mkdirSync(DIR, { recursive: true });

// Solo corre cuando se pide explícitamente (muta el demo: crea anónimos efímeros).
// Correr con: GEN_SHOTS=1 VITE_DEMO_ENABLED=true npx playwright test e2e/shots.spec.ts --project=chromium
test.beforeEach(() => {
  test.skip(!process.env.GEN_SHOTS, 'Generador de capturas — correr con GEN_SHOTS=1');
});

// Oculta la barra "Modo demo" para capturas limpias de marketing.
const OCULTAR = `.modo-demo-banner{display:none!important}`;

async function entrarDemo(page: import('@playwright/test').Page, label: string) {
  await page.goto('/para-gimnasios', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Probar demo' }).first().click();
  await page.getByText(label, { exact: false }).click();
}

test.describe.configure({ mode: 'serial', timeout: 90_000 });

test('admin — dashboard + agenda', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 650 }); // 16:10 para el BrowserFrame
  await entrarDemo(page, 'Vista admin');
  await page.waitForURL(/\/admin/, { timeout: 40_000 });
  await page.waitForTimeout(3500);
  await page.addStyleTag({ content: OCULTAR });
  await page.screenshot({ path: `${DIR}/dashboard.png` });

  await page.goto('/admin/agenda', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await page.addStyleTag({ content: OCULTAR });
  await page.screenshot({ path: `${DIR}/agenda.png` });
});

test('estudio — landing pública del gym', async ({ page }) => {
  // La landing del tenant vive en su subdominio (no en localhost), así que esta
  // se captura contra PROD. Es el hero branded de healthyspace para el showcase.
  await page.setViewportSize({ width: 1040, height: 650 }); // 16:10 para el BrowserFrame
  await page.goto('https://healthyspace.salastudio.app', { waitUntil: 'networkidle', timeout: 45_000 });
  await page.waitForTimeout(2500);
  await page.addStyleTag({
    content: `.modo-demo-banner,[class*="DemoBanner"],[class*="demo-banner"]{display:none!important}`
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${DIR}/estudio.png` });
});

test('recepción — check-in', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 650 }); // 16:10 para el BrowserFrame
  await entrarDemo(page, 'Vista recepción');
  await page.waitForURL(/\/recepcion/, { timeout: 40_000 });
  await page.waitForTimeout(3500);
  await page.addStyleTag({ content: OCULTAR });
  await page.screenshot({ path: `${DIR}/checkin.png` });
});

test('socio — reservar + mapa (mobile)', async ({ page }) => {
  await page.setViewportSize({ width: 402, height: 874 });
  await entrarDemo(page, 'Vista miembro');
  await page.waitForURL(/\/app/, { timeout: 40_000 });
  await page.waitForTimeout(2500);

  await page.goto('/app/reservar', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await page.addStyleTag({ content: OCULTAR });
  await page.screenshot({ path: `${DIR}/socio.png` });

  // Mapa de Salón: filtrar a Cycling (sala con mapa) → Reservar → modal con el
  // selector de lugar.
  await page.getByText('Cycling', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Reservar' }).first().click();
  await page.waitForTimeout(3000); // modal + layout/tomados
  await page.addStyleTag({ content: OCULTAR });
  await page.screenshot({ path: `${DIR}/mapa.png` });
});
