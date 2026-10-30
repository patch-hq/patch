import { test, expect } from '@playwright/test';

// Real-browser e2e for the goal row (spec/14 § Main chat panel — Goal bar).
// Real ChatRoute + real CSS via the dev harness, no backend. The goal text is
// edited in a modal, expandable in place, with metrics that wrap without clipping.
const HARNESS = '/app/dev-harness.html?chat=chat_tasks';
const LONG =
  'Ship the release by Friday with every migration applied, the changelog written, the APK published and the old goal text fully visible without truncation anywhere in the bar';

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile', { width: 390, height: 780 }],
] as const) {
  test.describe(`goal row — ${name}`, () => {
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

    test('a long goal is one ellipsised line folded, wrapped when opened from the pill', async ({
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
      const folded = (await text.boundingBox())!.height;
      expect(folded).toBeLessThan(24);
      const pill = page.getByTestId('goal-pill');
      await pill.click();
      await expect(pill).toHaveAttribute('aria-expanded', 'true');
      expect((await text.boundingBox())!.height).toBeGreaterThan(folded * 1.5);
      expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await pill.click();
      expect((await text.boundingBox())!.height).toBeLessThan(24);
    });

    test('the Goal row follows the shared anatomy; Edit goal opens the modal', async ({ page }) => {
      await page.goto(HARNESS);
      const bar = await page.getByTestId('goal-banner').boundingBox();
      expect(bar!.x).toBeGreaterThanOrEqual(0);
      expect(bar!.x + bar!.width).toBeLessThanOrEqual(viewport.width);
      await expect(page.getByTestId('goal-pill')).toContainText('Working');
      await expect(page.getByText('Goal active')).toHaveCount(0);
      await expect(page.getByTestId('goal-banner')).toContainText('1 check');
      const font = await page
        .getByTestId('goal-banner-text')
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(font).toBeLessThanOrEqual(14);
      const clear = await page.getByTestId('goal-clear-btn').boundingBox();
      const text = await page.getByTestId('goal-banner-text').boundingBox();
      expect(Math.abs(text!.y + text!.height / 2 - (clear!.y + clear!.height / 2))).toBeLessThan(
        text!.height / 2 + 4,
      );
      await page.getByTestId('goal-pill').click();
      await page.getByTestId('goal-edit-link').click();
      await expect(page.getByTestId('goal-edit-modal')).toBeVisible();
    });
  });
}
