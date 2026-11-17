import { test, expect } from '@playwright/test';

// Fresh-user test round 3: at the default window size the sidebar's "Name" sort
// tab read "Nar" — the segmented switch clipped its last tabs. Every tab must be
// fully inside the sidebar with its whole label showing.
const HARNESS = '/app/dev-harness.html';

for (const width of [1280, 1000, 800]) {
  test(`every sort tab shows its whole label at ${width}px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(HARNESS);
    const sidebar = page.locator('.sidebar-controls').first();
    await expect(page.getByTestId('sidebar-chat-sort-name')).toBeVisible();
    const sbBox = (await sidebar.boundingBox())!;
    for (const v of ['recent', 'created', 'name', 'manual']) {
      const tab = page.getByTestId(`sidebar-chat-sort-${v}`);
      const box = (await tab.boundingBox())!;
      expect(box.x + box.width, `${v} right edge`).toBeLessThanOrEqual(sbBox.x + sbBox.width + 0.5);
      const clipped = await tab.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(clipped, `${v} label clipped`).toBe(false);
    }
  });
}
