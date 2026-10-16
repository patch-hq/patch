import { test, expect } from '@playwright/test';

// Files and Terminal live in the header's ⋯ menu — no strip of their own.
test.use({ viewport: { width: 390, height: 780 } });
test('Files and Terminal are menu items, not a row under the header', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_md');
  await expect(page.getByTestId('chat-quicklinks')).toHaveCount(0);
  await expect(page.getByTestId('quicklink-files')).toHaveCount(0);
  await page.getByTestId('action-hamburger').click();
  await expect(page.getByTestId('quicklink-files')).toHaveText('Files');
  await expect(page.getByTestId('quicklink-terminal')).toHaveText('Terminal');
});
