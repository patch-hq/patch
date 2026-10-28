import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real ChatRoute + real CSS, no backend): a chat
// another chat launched with patch_spawn says so and links back to it.
test.describe('parent chat bar', () => {
  test('a launched chat names its launcher and opens it', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_launched');
    const bar = page.getByTestId('parent-chat-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Started by "release planner" chat');
    await page.getByTestId('parent-chat-bar-link').click();
    await expect(page.getByTestId('parent-chat-bar')).toHaveCount(0);
  });

  test('an ordinary chat shows no bar', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await expect(page.getByTestId('chat-main')).toBeVisible();
    await expect(page.getByTestId('parent-chat-bar')).toHaveCount(0);
  });

  test('can be dismissed', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_launched');
    await page.getByTestId('parent-chat-bar-dismiss').click();
    await expect(page.getByTestId('parent-chat-bar')).toHaveCount(0);
  });
});
