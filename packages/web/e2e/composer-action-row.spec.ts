import { test, expect, type Page } from '@playwright/test';

// The composer's action row (spec/14 § Composer) is always ONE line: call and
// meeting, the standing settings (approval mode, model, account, effort) and
// the end group (context ring, stop/send). When the settings' words don't fit
// they drop to icons; the row never wraps and nothing is clipped. Attach and
// sketch live behind the + inside the field, dictate at its right.

const CHAT = '/app/dev-harness.html?chat=chat_bus';

async function oneLine(page: Page): Promise<void> {
  const call = (await page.getByTestId('call-btn').boundingBox())!;
  const stop = (await page.getByTestId('stop-btn').boundingBox())!;
  const model = (await page.getByTestId('chat-model').boundingBox())!;
  const mid = (b: { y: number; height: number }): number => b.y + b.height / 2;
  expect(Math.abs(mid(model) - mid(call))).toBeLessThan(2);
  expect(Math.abs(mid(stop) - mid(call))).toBeLessThan(2);
  const row = (await page.locator('.composer-actions').boundingBox())!;
  expect(stop.x + stop.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
}

test('wide: settings read as icon and word on one line', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(CHAT);
  await expect(page.locator('.composer-actions')).not.toHaveClass(/is-compact/);
  await oneLine(page);
  await expect(page.getByTestId('permission-mode')).toHaveText(/Auto/);
});

test('phone: settings drop to icons, still one line, model keeps its short name', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(CHAT);
  await expect(page.locator('.composer-actions')).toHaveClass(/is-compact/);
  await oneLine(page);
  const word = page.getByTestId('permission-mode').locator('.setting-word');
  expect((await word.boundingBox())!.width).toBe(0);
  await expect(page.getByTestId('chat-model')).toHaveText(/Sonnet 4\.6/);
  await expect(page.getByTestId('chat-model')).not.toHaveText(/Claude/);
});

test('the + in the field offers a file or image, and a sketch', async ({ page }) => {
  await page.goto(CHAT);
  const input = (await page.getByTestId('composer-input').boundingBox())!;
  const add = (await page.getByTestId('composer-add-btn').boundingBox())!;
  const mic = (await page.getByTestId('voice-note-btn').boundingBox())!;
  expect(add.x).toBeGreaterThanOrEqual(input.x);
  expect(add.x).toBeLessThan(input.x + input.width / 2);
  expect(mic.x).toBeGreaterThan(input.x + input.width / 2);
  await page.getByTestId('composer-add-btn').click();
  await expect(page.getByTestId('add-menu-attach')).toHaveText('File or image');
  await expect(page.getByTestId('add-menu-sketch')).toHaveText('Sketch');
});
