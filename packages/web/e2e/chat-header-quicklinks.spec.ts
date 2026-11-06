import { test, expect } from '@playwright/test';

// Files and Terminal are the group header's own tool buttons — no strip of
// their own under it, and no ⋯ menu to hide them in (spec/14 § Groups).
test.use({ viewport: { width: 390, height: 780 } });
test('Files and Terminal are header buttons, not a row under the header', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_md');
  await expect(page.getByTestId('chat-quicklinks')).toHaveCount(0);
  await expect(page.getByTestId('quicklink-files')).toHaveCount(0);
  await expect(page.getByTestId('group-tool-files')).toBeVisible();
  await expect(page.getByTestId('group-tool-files')).toHaveAttribute('aria-label', 'Files');
  await expect(page.getByTestId('group-tool-terminal')).toBeVisible();
  await expect(page.getByTestId('group-tool-terminal')).toHaveAttribute('aria-label', 'Terminal');
});
