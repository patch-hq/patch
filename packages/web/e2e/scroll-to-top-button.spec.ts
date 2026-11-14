import { test, expect } from '@playwright/test';

// Todoist: "patch need a better way to scroll a super long chat".
// A long chat paints only its newest entries; an up arrow beside the down arrow
// mounts the rest and lands on the first message.

test.use({ viewport: { width: 1000, height: 700 } });

test('an up arrow in a long chat jumps to the first message', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_long_history');
  const stream = page.locator('.chat-stream');
  await expect(stream).toBeVisible();

  const up = page.getByTestId('scroll-to-top');
  await stream.hover();
  await page.mouse.wheel(0, -400);
  await expect(up).toBeVisible();

  await up.click();
  await expect(page.getByText('history line 0 —')).toBeVisible();
  await expect.poll(async () => stream.evaluate((el) => el.scrollTop)).toBeLessThan(5);
  await expect(up).toHaveCount(0);

  await page.getByTestId('scroll-to-bottom').click();
  await expect(page.getByText('history line 399 —')).toBeVisible();
});
