import { test, expect } from '@playwright/test';

// The agent's plan renders as a checklist card with a marker per step, not as
// an "Updating the todo list" row folded into a "Ran N commands" run.
test('a TodoWrite call is a checklist card with one marker per step', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_plan');
  const card = page.locator('[data-testid="todo-card"]');
  await expect(card).toBeVisible();
  const items = card.locator('[data-testid="todo-card-item"]');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute('data-status', 'completed');
  await expect(items.nth(1)).toHaveAttribute('data-status', 'in_progress');
  await expect(items.nth(2)).toHaveAttribute('data-status', 'pending');
  await expect(items.nth(0).locator('svg')).toHaveCount(1);
  await expect(items.nth(2).locator('svg')).toHaveCount(0);
  // The commands before it stay a run of their own; the plan is not in it.
  await expect(page.locator('[data-testid="tool-group"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="tool-call"]')).toHaveCount(1);
  const style = await items
    .nth(2)
    .locator('.todo-card-mark')
    .evaluate((el) => {
      const c = getComputedStyle(el);
      return { w: el.getBoundingClientRect().width, border: c.borderTopStyle };
    });
  expect(style.w).toBeGreaterThanOrEqual(14);
  expect(style.border).toBe('dashed');
  await page.screenshot({ path: '/tmp/todo-card.png' });
});

test('the plan call’s own result is not a second row', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_plan');
  await expect(page.locator('[data-testid="todo-card"]')).toBeVisible();
  await expect(page.locator('[data-testid="tool-result"]')).toHaveCount(0);
  await expect(page.getByText('undefined')).toHaveCount(0);
});
