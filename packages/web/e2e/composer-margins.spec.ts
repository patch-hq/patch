import { test, expect } from '@playwright/test';

// The composer's outer margins are even: 20px at the sides, 14px under the
// action row, and 8px between the field and the action row.

const CHAT = '/app/dev-harness.html?chat=chat_bus';

for (const [name, width] of [
  ['phone', 360],
  ['desktop', 1280],
] as const) {
  test(`${name}: composer margins are 20 / 14 and field-to-row gap is 8`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(CHAT);
    const composer = (await page.locator('.composer').boundingBox())!;
    const field = (await page
      .locator('.composer-row > .composer-field, .composer-row > :first-child')
      .first()
      .boundingBox())!;
    const actions = (await page.locator('.composer-actions').boundingBox())!;
    const bottom = (await page
      .getByTestId('stop-btn')
      .or(page.getByTestId('send-btn'))
      .first()
      .boundingBox())!;
    const pad = await page.locator('.composer').evaluate((el) => {
      const s = getComputedStyle(el);
      return { l: s.paddingLeft, r: s.paddingRight, b: s.paddingBottom };
    });
    expect(pad).toEqual({ l: '20px', r: '20px', b: '14px' });
    if (width < 780 + 40) {
      expect(field.x - composer.x).toBe(20);
      expect(composer.x + composer.width - (field.x + field.width)).toBe(20);
    }
    expect(composer.y + composer.height - (actions.y + actions.height)).toBe(14);
    const fieldBottom = (await page.locator('.composer-input-wrap').boundingBox())!;
    expect(actions.y - (fieldBottom.y + fieldBottom.height)).toBe(8);
    void bottom;
  });
}
