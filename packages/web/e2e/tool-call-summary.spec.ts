import { test, expect } from '@playwright/test';

// spec/14 § Main chat panel — Tool calls: a collapsed row says what the call is
// DOING, not just which tool ran. The fixture (dev-harness.tsx,
// chat_tool_single) fires three calls that each sit alone between turns, so
// none of them folds into a run and the collapsed row IS the whole surface.
// Real browser: only here can we prove the readable text is what is actually
// painted on the row, still one line high, with the args unrevealed.
const HARNESS = '/app/dev-harness.html?chat=chat_tool_single';

test.describe('tool call summaries', () => {
  test('an ungrouped call reads as what it is doing, not a bare tool name', async ({ page }) => {
    await page.goto(HARNESS);
    const calls = page.locator('[data-testid="tool-call"]');
    await expect(calls).toHaveCount(3);

    // The call carries its own description — that is the readable version of
    // what it is up to, so it wins over the raw command.
    await expect(calls.nth(0)).toContainText('Check the deploy log for errors');
    // No description: named by the file it read — its FILENAME, not the path
    // (spec/14 § Main chat panel), so the part that differs between rows is
    // the part that survives the row's one line.
    await expect(calls.nth(1)).toContainText('Reading poll.ts');
    await expect(calls.nth(1)).not.toContainText('src/poll.ts');
    // Nothing nameable: a plain phrase for the kind of work.
    await expect(calls.nth(2)).toContainText('Updating the todo list');

    // None of them is grouped — this is the ungrouped row's own summary.
    await expect(page.locator('[data-testid="tool-group"]')).toHaveCount(0);
  });

  test('the summary stays one line and keeps the args behind the disclosure', async ({ page }) => {
    await page.goto(HARNESS);
    const bash = page.locator('[data-testid="tool-call"]').first();

    // Collapsed by default, one row high — a description must not turn the row
    // into a paragraph.
    await expect(bash).toHaveAttribute('data-open', 'false');
    const height = await bash.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThan(48);

    // The command and the rest of the args are NOT on the collapsed row.
    await expect(bash).not.toContainText('/var/log/deploy.log');
    await expect(bash).not.toContainText('120000');

    await bash.locator('[data-testid="tool-call-summary"]').click();
    const detail = bash.locator('[data-testid="tool-call-detail"]');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('/var/log/deploy.log');
  });

  test('a run of calls stays one narrated line until expanded, then labels each call the same way the single rows are labelled', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_tools');
    const group = page.locator('[data-testid="tool-group"]').first();
    // Collapsed: what the batch did, not any call's target (spec/14 § Tool runs).
    await expect(group.locator('[data-testid="tool-group-summary"]')).toHaveText(
      '▸Searched for 2 patterns, read 1 file',
    );
    await expect(group).not.toContainText('Reading poll.ts');

    // Expanding the run shows the same per-call text an ungrouped row would —
    // the two surfaces share one derivation, so they cannot drift apart.
    await group.locator('[data-testid="tool-group-summary"]').click();
    await expect(group.locator('[data-testid="tool-call"]').nth(1)).toContainText(
      'Reading poll.ts',
    );
  });

  test('a run label squeezed by a narrow row ellipsizes inside its own box instead of being cut mid-word', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_tools');
    const group = page.locator('[data-testid="tool-group"]').first();
    const text = group.locator('.tool-summary-text');
    await group.evaluate((el) => {
      (el as HTMLElement).style.width = '120px';
    });
    const m = await text.evaluate((el) => {
      const cs = getComputedStyle(el);
      const btn = el.parentElement!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return {
        overflow: cs.overflow,
        textOverflow: cs.textOverflow,
        clipped: el.scrollWidth > el.clientWidth,
        inside: box.right <= btn.right + 0.5,
      };
    });
    expect(m.overflow).toBe('hidden');
    expect(m.textOverflow).toBe('ellipsis');
    expect(m.clipped).toBe(true);
    expect(m.inside).toBe(true);
  });
});
