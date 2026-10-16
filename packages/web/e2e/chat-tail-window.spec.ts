import { test, expect } from '@playwright/test';

// Todoist: "patch chats are still loading top down and its slow".
// spec/14 § Main chat panel — a long chat paints only its newest entries,
// at the bottom, and mounts older ones as the reader scrolls up.

test.use({ viewport: { width: 1000, height: 700 } });

test('a long chat opens on its newest 60 entries and mounts older ones on scroll', async ({
  page,
}) => {
  await page.goto('/app/dev-harness.html?chat=chat_long_history');
  const stream = page.locator('.chat-stream');
  const msgs = page.locator('[data-testid="msg"]');
  await expect(page.getByText('history line 399', { exact: false })).toBeVisible();
  await expect
    .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), {
      timeout: 4000,
    })
    .toBeLessThan(5);
  expect(await msgs.count()).toBeLessThanOrEqual(60);
  await expect(page.getByText('history line 100 ', { exact: false })).toHaveCount(0);

  const before = await msgs.count();
  await stream.hover();
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -700);
  await expect.poll(async () => msgs.count()).toBeGreaterThan(before);
});

test('opening Find in chat mounts the whole transcript', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_long_history');
  await expect(page.getByText('history line 399', { exact: false })).toBeVisible();
  await page.keyboard.press('Control+f');
  await expect.poll(async () => page.locator('[data-testid="msg"]').count()).toBe(400);
});
