import { test, expect } from '@playwright/test';

// A long wake message used to grow the Edit wake card taller than the window,
// pushing the date/time picker off the bottom edge. The card now caps its
// height and scrolls, so every control stays reachable.
const HARNESS = '/app/dev-harness.html?chat=chat_bus';

test('long message keeps the Edit wake card inside the window and the picker reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(HARNESS);
  await page.getByTestId('wake-bar-edit-btn').click();
  const card = page.getByTestId('wake-edit-modal');
  await expect(card).toBeVisible();

  await page.getByTestId('wake-edit-message').fill('long message line\n'.repeat(120));
  await page.getByTestId('wake-edit-at-open').click();

  const box = await card.boundingBox();
  if (!box) throw new Error('missing card box');
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(720);

  const done = page.getByTestId('wake-edit-at-done');
  await done.scrollIntoViewIfNeeded();
  await expect(done).toBeInViewport();
  await expect(page.getByTestId('wake-edit-save')).toBeAttached();
});
