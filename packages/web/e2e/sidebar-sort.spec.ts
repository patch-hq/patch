import { test, expect } from '@playwright/test';

// Sidebar ordering is chosen from an always-visible switch above the chat list,
// project ordering from Settings → Chats, and both stick across reloads.
const HARNESS = '/app/dev-harness.html';

test('sort switch is visible above the chats and persists', async ({ page }) => {
  await page.goto(HARNESS);
  await expect(page.getByTestId('sidebar-chat-sort-last-action')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId('sidebar-chat-sort-name')).toBeVisible();
  await page.getByTestId('sidebar-chat-sort-name').click();
  await page.reload();
  await expect(page.getByTestId('sidebar-chat-sort-name')).toHaveAttribute('aria-checked', 'true');
});
