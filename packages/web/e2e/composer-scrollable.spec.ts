import { test, expect } from '@playwright/test';

// A long message past the height cap must stay scrollable: by wheel, and the
// scroll position must survive the auto-grow effect re-running (it resets the
// height to `auto` on every change, which clamps scrollTop).
const HARNESS = '/app/dev-harness.html?chat=chat_bus';
const many = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');

test.describe('composer input scrolls when text exceeds the cap', () => {
  test('wheel scrolls the textarea', async ({ page }) => {
    await page.goto(HARNESS);
    const input = page.locator('.composer-input');
    await input.fill(many);
    await input.evaluate((el) => ((el as HTMLTextAreaElement).scrollTop = 0));
    await input.hover();
    await page.mouse.wheel(0, 120);
    await expect
      .poll(() => input.evaluate((el) => (el as HTMLTextAreaElement).scrollTop))
      .toBeGreaterThan(0);
  });

  test('scroll position survives an edit in the middle of the text', async ({ page }) => {
    await page.goto(HARNESS);
    // Browsers without `field-sizing` (older Android WebViews) collapse the box
    // to one row while the auto-grow effect measures it, clamping scrollTop.
    await page.addStyleTag({ content: '.composer-input { field-sizing: fixed !important; }' });
    const input = page.locator('.composer-input');
    await input.fill(many);
    await input.evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      t.setSelectionRange(0, 0);
      t.scrollTop = 0;
    });
    await input.evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      t.scrollTop = 200;
    });
    await input.evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      const pos = t.value.indexOf('line 11');
      t.focus();
      t.setSelectionRange(pos, pos);
    });
    const before = await input.evaluate((el) => (el as HTMLTextAreaElement).scrollTop);
    await page.keyboard.type('x');
    const after = await input.evaluate((el) => (el as HTMLTextAreaElement).scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(40);
  });
});

test.describe('composer input scrolls by touch on a phone', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test('a swipe over the input scrolls it', async ({ page }) => {
    await page.goto(HARNESS);
    const input = page.locator('.composer-input');
    await input.fill(many);
    await input.evaluate((el) => ((el as HTMLTextAreaElement).scrollTop = 0));
    const box = (await input.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y - i * 12 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect
      .poll(() => input.evaluate((el) => (el as HTMLTextAreaElement).scrollTop))
      .toBeGreaterThan(0);
  });
});
