import { test, expect } from '@playwright/test';

// spec/14 § New windows + § Layout (desktop) — the sidebar detached into its
// own window (`/sidebar-window`) fills that window and is never drawn narrower
// with no ceiling (User: "page is too narrow") — the 600px cap only applies to
// the docked sidebar's drag handle.
//
// Only a real browser can see any of this — jsdom computes no layout at all,
// so the cap, and the fact that a stylesheet `max-width` still beats the
// inline `width: 100%` Sidebar sets in standalone mode, are both invisible to
// the vitest suite.

const SIDEBAR_WINDOW = '/app/dev-harness.html?route=/sidebar-window';
const MAX = 600;

test.describe('detached sidebar window — width', () => {
  test('fills a wide window with no ceiling or gutter', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(SIDEBAR_WINDOW);

    const sb = page.getByTestId('sidebar');
    await expect(sb).toBeVisible();
    const box = (await sb.boundingBox())!;
    expect(box.width).toBeCloseTo(1000, 0);

    const row = (await page.locator('.sb-row').first().boundingBox())!;
    expect(row.width).toBeGreaterThan(MAX);
  });

  test('still fills a narrow window', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(SIDEBAR_WINDOW);
    const box = (await page.getByTestId('sidebar').boundingBox())!;
    expect(box.width).toBeCloseTo(320, 0);
  });
});
