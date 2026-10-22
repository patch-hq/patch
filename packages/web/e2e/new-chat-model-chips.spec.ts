import { test, expect } from '@playwright/test';

// Real-browser e2e for spec/14 § Sidebar §8: the new-chat screen's model chips
// are the account's default model first, marked, then the head of the live
// catalogue in its own order — never the models recent chats happened to run
// on. `?recency=machine` seeds a job-spawned chat and the Manager thread, both
// newer than the one chat a person started, each on a model of its own; none
// of that moves a chip.
const NEW = '/app/dev-harness.html?chat=new&recency=machine';

test('the model chips are the default, then the catalogue head, whatever the chats ran on', async ({
  page,
}) => {
  await page.route('**/api/models*', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
          { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
          { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
          { id: 'claude-opus-5', label: 'Claude Opus 5' },
          { id: 'claude-old-1', label: 'Claude Old 1' },
        ],
        fetchedAt: '2026-09-27T09:00:00.000Z',
      }),
    }),
  );
  await page.goto(NEW);
  const quick = page.getByTestId('new-chat-quick-models').locator('[data-testid^="model-quick-"]');
  await expect(quick).toHaveCount(4);
  const ids = await quick.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  // The harness machine's default (Opus 5) leads, marked; then the catalogue
  // in its order, with the fifth left to the pop-up.
  expect(ids).toEqual([
    'model-quick-claude-opus-5',
    'model-quick-claude-opus-4-1',
    'model-quick-claude-haiku-4-5',
    'model-quick-claude-sonnet-4-6',
  ]);
  await expect(quick.first().locator('.quick-sub')).toHaveText('default');
  await expect(quick.first()).toHaveAttribute('aria-pressed', 'true');
  // The pill is only the way to the rest while a chip carries the choice.
  await expect(page.getByTestId('new-chat-model').locator('.model-pill-label')).toHaveText('More…');
});
