import { test, expect } from '@playwright/test';

// Words said in a call carry a call mark (spec/07 § Words said in a call): a
// subtle outline icon in the gutter, outside the message itself.
test.describe('the call mark on spoken messages', () => {
  test('is an outline icon in the gutter, outside the message', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_voice');
    const marks = page.locator('[data-testid="msg-voice"]');
    await expect(marks).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const mark = marks.nth(i);
      const content = mark.locator('xpath=following-sibling::*[1]');
      const [m, c] = await Promise.all([mark.boundingBox(), content.boundingBox()]);
      expect(m!.x + m!.width).toBeLessThanOrEqual(c!.x);
      expect(await mark.locator('svg').getAttribute('fill')).toBe('none');
      expect(await mark.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
        'rgba(0, 0, 0, 0)',
      );
    }
  });
});
