import { test, expect } from '@playwright/test';

// System-role furniture rows ("Turn interrupted", "Goal not met", ...) share one
// style: same font family, size and left indent, and the expanded body is not
// monospace.
const HARNESS = '/app/dev-harness.html?chat=chat_furniture';

test('furniture rows share font, size and indent', async ({ page }) => {
  await page.goto(HARNESS);
  const notice = page.getByTestId('synthetic-notice').locator('.synthetic-notice-source').first();
  const goal = page.getByTestId('goal-trigger-summary');
  await expect(notice).toBeVisible();
  await expect(goal).toBeVisible();
  const style = (l: typeof notice) =>
    l.evaluate((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const inner = el.closest('[data-testid="synthetic-notice"], [data-testid="goal-trigger"]')!;
      const ir = inner.getBoundingClientRect();
      return { family: cs.fontFamily, size: cs.fontSize, indent: Math.round(r.left - ir.left) };
    });
  const a = await style(notice);
  const b = await style(goal);
  expect(b.family).toBe(a.family);
  expect(b.size).toBe(a.size);

  await goal.click();
  const detail = page.getByTestId('goal-trigger-detail');
  await expect(detail).toBeVisible();
  const fam = await detail.locator('code').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(fam).toBe(a.family);
});
