import { test, expect } from '@playwright/test';

// The composer's action row draws every icon at one size, and the model
// button carries an icon and a caret spaced like the approval-mode button's
// (spec/14 § Composer).

const CHAT = '/app/dev-harness.html?chat=chat_bus';

test('every icon in the action row is the same size', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(CHAT);
  await expect(page.getByTestId('chat-model')).toBeVisible();
  const sizes = await page
    .locator('.composer-actions svg')
    .evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().width)).filter((w) => w > 0),
    );
  expect(sizes.length).toBeGreaterThan(3);
  expect(new Set(sizes).size).toBe(1);
});

test('model button has an icon and its caret is spaced from the name', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(CHAT);
  const pill = page.getByTestId('chat-model');
  await expect(pill.locator('svg')).toHaveCount(1);
  const label = (await pill.locator('.model-pill-label').boundingBox())!;
  const caret = (await pill.locator('.model-pill-caret').boundingBox())!;
  expect(caret.x - (label.x + label.width)).toBeGreaterThanOrEqual(5);
});
