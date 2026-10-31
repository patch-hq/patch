import { test, expect } from '@playwright/test';

// spec/14 § Status list — Goal, Agents and Artifacts are one list in one
// container, every row on the same grid.
for (const [name, size] of [
  ['desktop', { width: 1600, height: 900 }],
  ['phone', { width: 390, height: 800 }],
] as const) {
  test(`the status list is one container of aligned rows (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/app/dev-harness.html?chat=chat_status');
    const list = page.locator('[data-testid="status-list"]');
    await expect(list).toBeVisible();
    await expect(page.locator('[data-testid="delegate-strip-toggle"]')).toContainText('3 running');
    await expect(page.locator('[data-testid="artifact-bar"]')).toBeVisible();

    const rows = list.locator('> * .status-row, > .status-row');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(3);
    const padding = size.width < 600 ? '16px' : '28px';
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(32);
      expect(await row.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe(padding);
      expect(await row.evaluate((el) => getComputedStyle(el).fontSize)).toBe('14px');
    }
    const labels = list.locator('.status-row-label').first();
    expect(await labels.isVisible()).toBe(size.width >= 600);
    // The chat title stands alone: no workers pill beside it.
    await expect(page.locator('[data-testid="header-workers"]')).toHaveCount(0);
  });
}
