import { test, expect } from '@playwright/test';

// spec/14 § Sidebar §1 and § Layout — the approved sidebar layout redesign
// (design/search-redesign): the search field and the view/sort controls are one
// fixed, opaque header with a hard bottom edge; the bottom nav is a single row
// of compact tabs with Files among them; the sidebar divider shows a grab
// handle, drags wider (max 600) and resets on double-click.
// Measured layout — jsdom cannot answer any of it.

const HARNESS = '/app/dev-harness.html?chat=chat_bus';

test.describe('sidebar layout redesign', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();
  });

  test('search and controls share one opaque header with a hard bottom edge', async ({ page }) => {
    const header = page.getByTestId('sb-header');
    await expect(header.getByTestId('sb-top-row')).toBeVisible();
    await expect(header.locator('.sidebar-controls')).toBeVisible();
    const style = await header.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, edge: cs.borderBottomWidth, z: cs.zIndex };
    });
    expect(style.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(parseFloat(style.edge)).toBeGreaterThanOrEqual(1);
    expect(Number(style.z)).toBeGreaterThan(0);
    const h = (await header.boundingBox())!;
    const list = (await page.getByTestId('sb-scroll').boundingBox())!;
    expect(list.y).toBeGreaterThanOrEqual(h.y + h.height - 0.5);
  });

  test('bottom nav is one compact row with Files beside the other tabs', async ({ page }) => {
    const ids = ['nav-files', 'nav-pads', 'nav-jobs', 'nav-settings'];
    const boxes = [];
    for (const id of ids) boxes.push((await page.getByTestId(id).boundingBox())!);
    for (const b of boxes) expect(Math.abs(b.y - boxes[0]!.y)).toBeLessThan(1);
    expect(boxes[0]!.height).toBeLessThan(44);
    expect(boxes[0]!.width).toBeLessThan(120);
  });

  test('divider has a visible grab handle', async ({ page }) => {
    const handle = await page.getByTestId('sidebar-divider').evaluate((el) => {
      const cs = getComputedStyle(el, '::before');
      return { w: parseFloat(cs.width), h: parseFloat(cs.height), bg: cs.backgroundColor };
    });
    expect(handle.w).toBeGreaterThan(2);
    expect(handle.h).toBeGreaterThan(20);
    expect(handle.bg).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('dragging the divider widens the sidebar, capped at 600; double-click resets', async ({
    page,
  }) => {
    const sb = page.getByTestId('sidebar');
    const div = page.getByTestId('sidebar-divider');
    const start = (await sb.boundingBox())!.width;
    const d = (await div.boundingBox())!;
    const y = d.y + d.height / 2;
    await page.mouse.move(d.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(d.x + 2 + 120, y, { steps: 5 });
    await page.mouse.up();
    const wider = (await sb.boundingBox())!.width;
    expect(wider).toBeGreaterThan(start + 100);

    const d2 = (await div.boundingBox())!;
    await page.mouse.move(d2.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(d2.x + 2 + 900, y, { steps: 5 });
    await page.mouse.up();
    expect((await sb.boundingBox())!.width).toBeLessThanOrEqual(600);

    await div.dblclick();
    expect((await sb.boundingBox())!.width).toBeCloseTo(280, 0);
  });
});
