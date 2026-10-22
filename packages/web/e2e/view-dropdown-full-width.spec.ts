import { test, expect } from '@playwright/test';

// Todoist: "patch make all chats filter dropdown full width" — the view
// trigger sized to its own label; it must fill the controls row.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 800 },
]) {
  test(`view dropdown fills the controls row at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(HARNESS);
    if (viewport.width < 768) await page.getByTestId('sidebar-expand').click();
    const controls = page.locator('.sidebar-controls');
    const trigger = page.getByTestId('sidebar-view-trigger');
    await expect(trigger).toBeVisible();
    // Poll: the sidebar may still be animating open at narrow widths.
    await expect
      .poll(async () => {
        const c = (await controls.boundingBox())!;
        const t = (await trigger.boundingBox())!;
        return [Math.round(t.x - c.x), Math.round(c.width - t.width)];
      })
      .toEqual([0, 0]);
  });
}
