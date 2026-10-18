import { test, expect } from '@playwright/test';

// Real-browser e2e for the goal bar (spec/14 § Main chat panel — Goal bar).
// Real ChatRoute + real CSS via the dev harness, no backend. The goal text is
// shown in full (wrapped) and edited in a modal; everything else sits on one
// readable line.
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

    test('a long goal is clamped to two readable lines; full text in the title', async ({
      page,
    }) => {
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
    });

    test('goal bar is two lines at most: goal + clear, then one muted metrics line', async ({
      page,
    }) => {
      await page.goto(HARNESS);
      const bar = await page.getByTestId('goal-banner').boundingBox();
      expect(bar!.height).toBeLessThan(80);
      const clear = await page.getByTestId('goal-clear-btn').boundingBox();
      const text = await page.getByTestId('goal-banner-text').boundingBox();
      expect(Math.abs(text!.y + text!.height / 2 - (clear!.y + clear!.height / 2))).toBeLessThan(
        text!.height / 2 + 4,
      );
      await expect(page.locator('[data-testid^="goal-banner-cell-"]')).toHaveCount(3);
      const meta = await page.getByTestId('goal-banner-meta').boundingBox();
      expect(meta!.y).toBeGreaterThanOrEqual(text!.y + text!.height - 1);
      expect(meta!.height).toBeLessThan(24);
    });
  });
}
