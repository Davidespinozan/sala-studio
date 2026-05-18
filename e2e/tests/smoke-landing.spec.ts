import { test, expect } from '@playwright/test';

test.describe('Landing', () => {
  test('placeholder — se implementa en Fase 6', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/EKKO/);
  });
});
