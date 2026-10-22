import { test, expect } from '@playwright/test';

// A turn that failed because the conversation no longer fits the model's
// context window says so, says an unchanged retry will fail, and keeps the
// provider's text behind Details. Checked at desktop and phone widths.
for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile', { width: 390, height: 780 }],
] as const) {
  test(`context-length failure is explained (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/app/dev-harness.html?chat=chat_context_overflow');
    const failed = page.locator('[data-testid="turn-failed"]');
    await expect(failed).toBeVisible();
    await expect(failed).toHaveAttribute('data-failure-kind', 'context_length');
    await expect(page.locator('[data-testid="turn-failed-reason"]')).toContainText(/too large/i);
    await expect(page.locator('[data-testid="turn-failed-reason"]')).toContainText(/fail again/i);
    await expect(page.locator('[data-testid="turn-retry"]')).toHaveText('Retry anyway');
    await page.locator('[data-testid="turn-failed-detail"] summary').click();
    await expect(page.locator('[data-testid="turn-failed-detail"] pre')).toContainText(
      'context_length_exceeded',
    );
    const box = await failed.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  });
}
