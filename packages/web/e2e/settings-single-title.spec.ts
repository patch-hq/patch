import { test, expect } from '@playwright/test';

test('Settings page is named once on desktop: the nav row, not a repeat heading', async ({
  page,
}) => {
  await page.goto('/app/dev-harness.html?route=/settings/hosts');
  const main = page.getByTestId('settings-main');
  await expect(main).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('group-title')).toHaveCount(0);
  const h1 = main.locator('.set-head h1');
  const box = await h1.boundingBox();
  expect(box === null || box.width <= 1).toBe(true);
  await page.screenshot({ path: process.env.SHOT ?? '/tmp/settings-single-title.png' });
});
