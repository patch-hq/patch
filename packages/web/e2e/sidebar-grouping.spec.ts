import { test, expect } from '@playwright/test';

// The sidebar groups chats by project (default) or by status, from an
// always-visible switch; the choice sticks across reloads.
const HARNESS = '/app/dev-harness.html';

test('grouping switch regroups the list under status headings and persists', async ({ page }) => {
  await page.goto(HARNESS);
  await expect(page.getByTestId('sidebar-grouping-project')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByTestId('sidebar-grouping-status').click();
  await expect(page.locator('[data-testid^="status-section-status:"]').first()).toBeVisible();
  await expect(page.locator('[data-testid^="folder-collapse-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="row-project-"]').first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('sidebar-grouping-status')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('sidebar-grouping-project').click();
  await expect(page.locator('[data-testid^="folder-collapse-"]').first()).toBeVisible();
});
