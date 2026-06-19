import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * Fase 1 — humo read-only contra el tenant que carga en localhost (healthyspace,
 * el demo). NO requiere login ni muta datos. Cubre las clases de regresión que
 * ya nos mordieron: pantallas en blanco/ErrorBoundary, desborde horizontal en
 * mobile, y crashes que dejan la consola con errores.
 */

// Ruido de consola que NO cuenta como fallo (3rd-party / infra esperada).
const RUIDO = [
  /sentry/i, // [sentry] DSN no definida en este entorno
  /favicon/i,
  /manifest/i,
  /Download the React DevTools/i,
  /\[vite\]/i,
  /interactive-widget/i // WebKit: warning del meta viewport, no es un error de la app
];

function capturarErrores(page: Page): string[] {
  const errores: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error' && !RUIDO.some((r) => r.test(msg.text()))) {
      errores.push(msg.text());
    }
  });
  page.on('pageerror', (err) => errores.push(err.message));
  return errores;
}

test.describe('Landing pública (tenant)', () => {
  test('renderiza sin crash y con la marca del tenant', async ({ page }) => {
    const errores = capturarErrores(page);
    await page.goto('/');

    // Título = nombre del tenant (o SALA como fallback). Si el TenantProvider
    // fallara, esto no se cumpliría.
    await expect(page).toHaveTitle(/Healthy Space|SALA/i);

    // Atribución del pie → confirma que el árbol llegó hasta el footer (no quedó
    // en loading ni en la pantalla de error).
    await expect(page.getByText(/Powered by/i)).toBeVisible();

    // Ningún ErrorBoundary ni error de consola real.
    expect(errores, `errores de consola:\n${errores.join('\n')}`).toEqual([]);
  });

  test('sin desborde horizontal en viewport mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14 lógico
    await page.goto('/');
    await expect(page.getByText(/Powered by/i)).toBeVisible();

    const desborda = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    expect(desborda, 'la página desborda horizontalmente en mobile').toBe(false);
  });
});

test.describe('Auth / routing público', () => {
  test('/login muestra el formulario', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button')).toBeVisible();
  });

  test('una ruta desconocida no rompe la app', async ({ page }) => {
    const errores = capturarErrores(page);
    await page.goto('/ruta-que-no-existe-12345');
    // No exigimos un 404 específico, solo que la SPA siga viva y sin crash.
    await expect(page.locator('#root')).not.toBeEmpty();
    expect(errores, `errores de consola:\n${errores.join('\n')}`).toEqual([]);
  });
});
