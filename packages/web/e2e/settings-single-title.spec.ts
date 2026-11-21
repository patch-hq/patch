import { test, expect } from '@playwright/test';

test('Settings page title is always shown on desktop', async ({ page }) => {
  await page.goto('/app/dev-harness.html?route=/settings/hosts');
  const main = page.getByTestId('settings-main');
  await expect(main).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('group-title')).toHaveCount(0);
  const box = await main.locator('.set-head h1').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(1);
  await page.screenshot({ path: process.env.SHOT ?? '/tmp/settings-single-title.png' });
});
