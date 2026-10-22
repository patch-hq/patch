import { test, expect } from '@playwright/test';

// Real-browser e2e for the goal bar (spec/14 § Main chat panel — Goal bar).
// Real ChatRoute + real CSS via the dev harness, no backend. The goal text is
// edited in a modal, expandable in place, with metrics that wrap without clipping.
const HARNESS = '/app/dev-harness.html?chat=chat_tasks';
const LONG =
  'Ship the release by Friday with every migration applied, the changelog written, the APK published and the old goal text fully visible without truncation anywhere in the bar';

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile', { width: 390, height: 780 }],
] as const) {
  test.describe(`goal bar — ${name}`, () => {
    test.use({ viewport });

    test('clicking the goal opens a modal; saving posts the new goal', async ({ page }) => {
      let posted: unknown = null;
      await page.route('**/api/chats/*/goal', async (r) => {
        posted = r.request().postDataJSON();
        await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      await page.goto(HARNESS);
      await page.getByTestId('goal-banner-text').click();
      const input = page.getByTestId('goal-edit-input');
      await expect(input).toBeFocused();
      await input.fill(LONG);
      await page.getByTestId('goal-edit-save').click();
      await expect(page.getByTestId('goal-edit-modal')).toHaveCount(0);
      await expect(page.getByTestId('goal-banner-text')).toHaveText(LONG);
      await expect.poll(() => posted).toEqual({ goal: LONG });
    });

    test('a long goal is clamped to two readable lines and expands in place', async ({ page }) => {
      await page.route('**/api/chats/*/goal', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
      );
      await page.goto(HARNESS);
      await page.getByTestId('goal-banner-text').click();
      await page.getByTestId('goal-edit-input').fill(LONG);
      await page.getByTestId('goal-edit-save').click();
      const text = page.getByTestId('goal-banner-text');
      await expect(text).toHaveAttribute('title', LONG);
      const m = await text.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          h: el.getBoundingClientRect().height,
          lh: parseFloat(cs.lineHeight),
          font: parseFloat(cs.fontSize),
        };
      });
      expect(m.font).toBeGreaterThanOrEqual(15);
      expect(m.h).toBeLessThanOrEqual(m.lh * 2 + 2);
      const expand = page.getByTestId('goal-expand-btn');
      await expand.click();
      await expect(expand).toHaveAttribute('aria-expanded', 'true');
      expect(await text.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      await expand.click();
      await expect(expand).toHaveAttribute('aria-expanded', 'false');
      expect((await text.boundingBox())!.height).toBeLessThanOrEqual(m.lh * 2 + 2);
    });

    test('goal state and controls stay readable while metrics wrap inside the bar', async ({
      page,
    }) => {
      await page.goto(HARNESS);
      const bar = await page.getByTestId('goal-banner').boundingBox();
      expect(bar!.x).toBeGreaterThanOrEqual(0);
      expect(bar!.x + bar!.width).toBeLessThanOrEqual(viewport.width);
      await expect(page.getByTestId('goal-banner-label')).toHaveText('Goal active');
      const clear = await page.getByTestId('goal-clear-btn').boundingBox();
      const text = await page.getByTestId('goal-banner-text').boundingBox();
      expect(Math.abs(text!.y + text!.height / 2 - (clear!.y + clear!.height / 2))).toBeLessThan(
        text!.height / 2 + 4,
      );
      await expect(page.locator('[data-testid^="goal-banner-cell-"]')).toHaveCount(3);
      const meta = await page.getByTestId('goal-banner-meta').boundingBox();
      expect(meta!.y).toBeGreaterThanOrEqual(text!.y + text!.height - 1);
      expect(meta!.y + meta!.height).toBeLessThanOrEqual(bar!.y + bar!.height);
      await expect(page.getByTestId('goal-banner-cell-turns')).toHaveText('1 check');
      const cells = page.getByTestId('goal-banner-meta').locator('span');
      for (const cell of await cells.all()) {
        const box = (await cell.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(meta!.x);
        expect(box.x + box.width).toBeLessThanOrEqual(meta!.x + meta!.width + 1);
        expect(await cell.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
    });
  });
}
