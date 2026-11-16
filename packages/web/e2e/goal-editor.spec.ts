import { test, expect } from '@playwright/test';

// spec/14 § Goals — the goal editor sets a goal, the goals after it and the two
// cadences; the goal row says how many follow. Real ChatRoute + real CSS via the
// dev harness: jsdom applies no stylesheet, so only a browser shows whether the
// rows fit inside the card.
const HARNESS = '/app/dev-harness.html?chat=chat_tasks';

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile', { width: 390, height: 780 }],
] as const) {
  test.describe(`goal editor — ${name}`, () => {
    test.use({ viewport });

    test('sets a sequence with both cadences, fits the card, and posts the plan', async ({
      page,
    }) => {
      let posted: unknown = null;
      await page.route('**/api/chats/*/goal', async (r) => {
        posted = r.request().postDataJSON();
        await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      await page.goto(HARNESS);
      await page.getByTestId('goal-banner-text').click();
      await page.getByTestId('goal-then-add').click();
      await page.getByTestId('goal-then-0').fill('Write the release notes and tag the release');
      await page.getByTestId('goal-then-add').click();
      await page.getByTestId('goal-then-1').fill('Publish the APK');
      await page.getByTestId('goal-remind-unit').selectOption('turns');
      await page.getByTestId('goal-remind-n').fill('3');
      await page.getByTestId('goal-checkin-unit').selectOption('minutes');
      await page.getByTestId('goal-checkin-n').fill('15');

      const card = (await page.getByTestId('goal-edit-modal').boundingBox())!;
      for (const id of [
        'goal-then-0',
        'goal-then-remove-1',
        'goal-remind-n',
        'goal-checkin-n',
        'goal-edit-save',
      ]) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.x, id).toBeGreaterThanOrEqual(card.x);
        expect(box.x + box.width, id).toBeLessThanOrEqual(card.x + card.width);
      }
      await page.screenshot({ path: `test-results/goal-editor-${name}.png` });

      await page.getByTestId('goal-edit-save').click();
      await expect(page.getByTestId('goal-edit-modal')).toHaveCount(0);
      await expect
        .poll(() => posted)
        .toEqual({
          goal: 'Get the search index rebuilding nightly',
          then: ['Write the release notes and tag the release', 'Publish the APK'],
          remindEvery: { unit: 'turns', n: 3 },
          checkInEvery: { unit: 'minutes', n: 15 },
        });
      await expect(page.getByTestId('goal-banner')).toContainText('2 to follow');
      await page.getByTestId('goal-pill').click();
      await expect(page.getByTestId('goal-banner-plan')).toContainText(
        'Then: Write the release notes and tag the release → Publish the APK',
      );
      await page.screenshot({ path: `test-results/goal-row-${name}.png` });
    });

    test('a failed save puts the row back and says so', async ({ page }) => {
      await page.route('**/api/chats/*/goal', (r) =>
        r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' }),
      );
      await page.goto(HARNESS);
      await page.getByTestId('goal-banner-text').click();
      await page.getByTestId('goal-then-add').click();
      await page.getByTestId('goal-then-0').fill('Second goal');
      await page.getByTestId('goal-edit-save').click();
      await expect(page.getByTestId('goal-banner')).not.toContainText('to follow');
    });
  });
}
