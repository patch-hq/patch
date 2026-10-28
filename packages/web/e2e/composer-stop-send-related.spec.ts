import { test, expect, type Page } from '@playwright/test';

// Stop and Send are one control in two states (spec/14 § Composer): both are a
// solid filled square of the same size, differing only in colour.

const CHAT = '/app/dev-harness.html?chat=chat_bus';

async function style(page: Page, id: string) {
  return page.getByTestId(id).evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      bg: s.backgroundColor,
      border: s.borderTopColor,
      color: s.color,
      w: s.width,
      h: s.height,
      radius: s.borderRadius,
    };
  });
}

for (const [name, size] of [
  ['wide', { width: 1280, height: 800 }],
  ['phone', { width: 360, height: 800 }],
] as const) {
  test(`${name}: stop is a solid fill like an enabled send`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto(CHAT);
    const stop = await style(page, 'stop-btn');
    expect(stop.bg).toBe(stop.border);
    expect(stop.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(stop.w).toBe('40px');
    expect(stop.h).toBe('40px');
  });
}
