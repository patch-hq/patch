import { test, expect } from '@playwright/test';

// Sidebar ordering is chosen from its own control above the chat list and sticks across reloads.
const HARNESS = '/app/dev-harness.html';

test('sort choice is offered above the chats and persists', async ({ page }) => {
  await page.goto(HARNESS);
  await page.getByTestId('sidebar-sort-trigger').click();
  await expect(page.getByText('Agent updates won’t move conversations')).toBeVisible();
  await expect(page.getByTestId('sidebar-chat-sort-last-action')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByTestId('sidebar-chat-sort-name').click();
  await page.getByTestId('sidebar-sort-advanced').click();
  await expect(page.getByTestId('sidebar-group-sort-same-as-chats')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByTestId('sidebar-group-sort-last-update').click();
  await page.reload();
  await page.getByTestId('sidebar-sort-trigger').click();
  await expect(page.getByTestId('sidebar-chat-sort-name')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('sidebar-sort-advanced').click();
  await expect(page.getByTestId('sidebar-group-sort-last-update')).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
