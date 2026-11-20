import { test, expect } from '@playwright/test';

// The Waiting page (spec/14 § Waiting view) in a real browser: the dev harness
// seeds chats with pending self-wakes and serves one one-off job that messages
// `chat_bus`, so the page shows timers and an event wait.
const HARNESS = '/app/dev-harness.html?route=/waiting';

test.describe('waiting page', () => {
  test('lists timers and the event wait, and opens the chat on click', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('waiting-route')).toBeVisible();
    await expect(page.getByTestId('waiting-row-job:j_wait1')).toContainText('PR 412 merged');
    await expect(page.getByTestId('waiting-row-wake:chat_bus')).toContainText(
      'check whether the 36 has left the depot',
    );
    await expect(page.getByTestId('waiting-row-wake:chat_loop_waiting')).toContainText(
      'after the current turn',
    );
    await page.getByTestId('waiting-row-wake:chat_bus').click();
    await expect(page.getByTestId('wake-bar')).toBeVisible();
  });
});
