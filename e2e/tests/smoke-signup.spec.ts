import { test, expect } from '@playwright/test';

/**
 * Humo del signup público (read-only, NO envía el formulario → no crea cuentas).
 * El tenant de localhost (healthyspace) es multisede, así que el alta debe
 * mostrar el selector de sede (Fase 7 multi-sucursal) con 2+ opciones.
 */
test.describe('Signup público (multi-sucursal)', () => {
  test('alta renderiza el formulario y el selector de sede (multisede)', async ({ page }) => {
    await page.goto('/signup'); // sin ?tier → plan basica por defecto (siempre existe)

    // El formulario montó (no rebotó a "/").
    await expect(page.locator('input[type="email"]')).toBeVisible();

    // Selector de sede del alta (solo aparece con 2+ sedes activas).
    const sede = page.locator('#signup-sucursal');
    await expect(sede).toBeVisible();

    // Al menos 2 sedes reales + el placeholder "Elige tu sede…".
    const opciones = await sede.locator('option').count();
    expect(opciones).toBeGreaterThanOrEqual(3);
  });
});
