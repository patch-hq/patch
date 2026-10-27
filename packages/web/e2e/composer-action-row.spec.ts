import { test, expect, type Page } from '@playwright/test';

// The composer's action row (spec/14 § Composer): tools, the standing settings
// (approval mode, model, effort) and the end group (context ring, stop/send).
// One line when everything fits; otherwise the settings take a line of their
// own under the tools. Either way no setting is clipped to an ellipsis.

const CHAT = '/app/dev-harness.html?chat=chat_bus';

async function noneClipped(page: Page): Promise<void> {
  const clipped = await page.$$eval(
    '.composer-settings button, .composer-settings .model-pill-label',
    (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
  );
  expect(clipped).toEqual([]);
}

test('wide: tools, settings and stop share one line', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(CHAT);
  const row = page.locator('.composer-actions');
  await expect(row).not.toHaveClass(/is-stacked/);
  const attach = (await page.getByTestId('attach-btn').boundingBox())!;
  const effort = (await page.getByTestId('chat-effort').boundingBox())!;
  const stop = (await page.getByTestId('stop-btn').boundingBox())!;
  expect(Math.abs(effort.y + effort.height / 2 - (attach.y + attach.height / 2))).toBeLessThan(2);
  expect(effort.x + effort.width).toBeLessThanOrEqual(stop.x);
  await noneClipped(page);
});

test('narrow: settings drop to their own line, stop stays top-right', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(CHAT);
  const row = page.locator('.composer-actions');
  await expect(row).toHaveClass(/is-stacked/);
  const attach = (await page.getByTestId('attach-btn').boundingBox())!;
  const stop = (await page.getByTestId('stop-btn').boundingBox())!;
  const mode = (await page.getByTestId('permission-mode').boundingBox())!;
  // Stop on the tools' line, at the right.
  expect(Math.abs(stop.y - attach.y)).toBeLessThan(2);
  // Settings start below it, from the left edge.
  expect(mode.y).toBeGreaterThanOrEqual(attach.y + attach.height);
  expect(mode.x).toBeLessThan(attach.x + attach.width);
  await expect(page.getByTestId('chat-model')).toBeVisible();
  await expect(page.getByTestId('chat-effort')).toBeVisible();
  await noneClipped(page);
});

test('the mic sits inside the text field', async ({ page }) => {
  await page.goto(CHAT);
  const input = (await page.getByTestId('composer-input').boundingBox())!;
  const mic = (await page.getByTestId('voice-note-btn').boundingBox())!;
  expect(mic.x + mic.width).toBeLessThanOrEqual(input.x + input.width);
  expect(mic.y).toBeGreaterThanOrEqual(input.y);
  expect(mic.y + mic.height).toBeLessThanOrEqual(input.y + input.height);
  await expect(page.locator('.composer-actions').getByTestId('voice-note-btn')).toHaveCount(0);
});
