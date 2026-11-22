import { test, expect } from '@playwright/test';

// Zen mode: one chat, nothing else. ⌘. enters it from an open chat and the
// sidebar, header controls and composer pickers are gone; the transcript, the
// composer text box and the zen button stay. Leaving brings it all back.

const HARNESS = '/app/dev-harness.html?chat=chat_bus';

test.describe('zen mode', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('hides everything but the chat and the box to answer it', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('chat-head-actions')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('normal.png') });

    await page.keyboard.press('Meta+.');
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
    await expect(page.getByTestId('chat-head-actions')).toBeHidden();
    await expect(page.getByTestId('permission-mode')).toBeHidden();
    await expect(page.getByTestId('chat-title')).toBeVisible();
    await expect(page.getByTestId('action-zen')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('zen.png') });

    await page.keyboard.press('Meta+.');
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('permission-mode')).toBeVisible();
  });
});
