import { test, expect } from '@playwright/test';

// A user message that fits on one line in the reading column must not wrap
// (todo: "patch line wrap for no reason"). The bubble was capped at 82% of the
// column, so text up to 100% wide broke onto a second line with room to spare.
test('a user message that fits the column stays on one line', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/app/dev-harness.html?chat=chat_user_fits_measure');
  const bubble = page.locator('.msg-user .content').first();
  await expect(bubble).toBeVisible();

  const m = await bubble.evaluate((el) => {
    const p = el.querySelector('p') ?? el;
    const clone = p.cloneNode(true) as HTMLElement;
    clone.style.cssText =
      'position:absolute;visibility:hidden;white-space:nowrap;width:max-content';
    el.appendChild(clone);
    const natural = clone.getBoundingClientRect().width;
    clone.remove();
    const col = el.closest('.chat-stream-content')!.getBoundingClientRect().width;
    const cs = getComputedStyle(el);
    const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2;
    const lineH = parseFloat(getComputedStyle(p).lineHeight);
    return { natural, col, chrome, pHeight: p.getBoundingClientRect().height, lineH };
  });
  // Precondition: the fixture must sit between 82% and 100% of the column.
  expect(m.natural + m.chrome).toBeGreaterThan(m.col * 0.82);
  expect(m.natural + m.chrome).toBeLessThan(m.col);
  expect(m.pHeight).toBeLessThan(m.lineH * 1.5);
});
