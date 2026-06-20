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

test.describe.configure({ mode: 'serial', timeout: 160_000 });

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

test('estudio — landing pública del gym (mobile)', async ({ page }) => {
  // La landing del tenant en MÓVIL (lo que más le importa al dueño: cómo la ven
  // sus socios en el celular). localhost/ renderiza el tenant demo (healthyspace).
  await page.setViewportSize({ width: 402, height: 874 }); // 9:19.5 para el PhoneFrame
  await page.goto('/', { waitUntil: 'networkidle', timeout: 45_000 });
  await page.waitForTimeout(2500);
  await page.addStyleTag({
    content: `.modo-demo-banner,[class*="DemoBanner"],[class*="demo-banner"]{display:none!important}
      .reveal{opacity:1!important;transform:none!important}`
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
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

test('socio — mapa + inicio con QR + reservar (mobile)', async ({ page }) => {
  await page.setViewportSize({ width: 402, height: 874 });
  await entrarDemo(page, 'Vista miembro');
  await page.waitForURL(/\/app/, { timeout: 40_000 });
  await page.waitForTimeout(2500);

  // 1) Mapa de Salón (solo captura): Cycling → primer día con clase → abrir modal.
  await page.goto('/app/reservar', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.getByText('Cycling', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(900);
  const tabs = page.getByRole('tablist', { name: 'Selector de día' }).getByRole('tab');
  const nTabs = await tabs.count();
  for (let i = 0; i < nTabs; i++) {
    await tabs.nth(i).click().catch(() => {});
    await page.waitForTimeout(1200);
    if ((await page.getByRole('button', { name: 'Reservar' }).count()) > 0) break;
  }
  await page.getByRole('button', { name: 'Reservar' }).first().click();
  await page.waitForTimeout(2800);
  await page.addStyleTag({ content: OCULTAR });
  await page.screenshot({ path: `${DIR}/mapa.png` });

  // 2) Reservar de verdad una clase lejana (≥ anticipación) → activa el QR del home.
  //    Prueba días lejanos; si una clase está muy próxima, cancela y sigue.
  await page.goto('/app/reservar', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const tabsB = page.getByRole('tablist', { name: 'Selector de día' }).getByRole('tab');
  const nB = await tabsB.count();
  for (const i of [4, 5, 6, 3, 2].filter((x) => x < nB)) {
    await tabsB.nth(i).click().catch(() => {});
    await page.waitForTimeout(1400);
    if ((await page.getByRole('button', { name: 'Reservar' }).count()) === 0) continue;
    await page.getByRole('button', { name: 'Reservar' }).first().click();
    await page.waitForTimeout(2500);
    await page.locator('button[aria-label^="Elegir lugar"]').first().click().catch(() => {});
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /^Confirmar/ }).click().catch(() => {});
    await page.waitForTimeout(3000);
    if ((await page.getByText(/anticipaci[oó]n/i).count()) > 0) {
      await page.getByRole('button', { name: 'Cancelar' }).click().catch(() => {});
      await page.waitForTimeout(800);
      continue;
    }
    break;
  }

  // 3) Inicio con la reserva → "Tu próxima clase" + Mi QR.
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.addStyleTag({ content: OCULTAR });
  await page.screenshot({ path: `${DIR}/inicio.png` });

  // 4) Reservar: día con MÁS clases (Todas las salas) → varias para reservar.
  await page.goto('/app/reservar', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const tabs2 = page.getByRole('tablist', { name: 'Selector de día' }).getByRole('tab');
  const n2 = await tabs2.count();
  let best = 0, bestCount = -1;
  for (let i = 0; i < n2; i++) {
    await tabs2.nth(i).click().catch(() => {});
    await page.waitForTimeout(1000);
    const c = await page.getByRole('button', { name: 'Reservar' }).count();
    if (c > bestCount) { bestCount = c; best = i; }
  }
  await tabs2.nth(best).click().catch(() => {});
  await page.waitForTimeout(1800);
  await page.addStyleTag({ content: OCULTAR });
  await page.screenshot({ path: `${DIR}/socio.png` });
});
