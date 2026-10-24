import { test, expect, type Page } from '@playwright/test';

// spec/12 § Cold start — the device paints a chat from its own transcript
// cache before the host answers. A question's ANSWER (`chat.permission_response`)
// carries no seq, so the cache used to drop it: the request came back from
// IndexedDB and drew an open, blank card with a live Send answer button while
// the agent already had the reply (Todoist: "answered questions reappear open
// and blank after a reload"). jsdom has no IndexedDB and no real reload, so
// this runs the real cache in a real browser across a real `page.reload()`.
//
// `chat_cache_question` has no timeline fixture: whatever it shows came out of
// IndexedDB.
const HARNESS = '/app/dev-harness.html?chat=chat_cache_question&ws=fake';
const CHAT = 'chat_cache_question';

type CacheWindow = {
  __transcriptCache: {
    saveEvents(chatId: string, events: unknown[]): Promise<void>;
    loadTranscript(chatId: string): Promise<{ resolutions: unknown[] } | null>;
  };
};

const request = (expiry?: { at: number; windowMs: number }): Record<string, unknown> => ({
  type: 'chat.permission_request',
  chatId: CHAT,
  seq: 645,
  requestId: 'req-cache-question',
  request: {
    tool: 'AskUserQuestion',
    description: 'Ask the user',
    args: {
      questions: [
        {
          header: 'Library',
          question: 'Which date library should we use?',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'Tree-shakeable.' },
            { label: 'Luxon', description: 'Rich zone handling.' },
          ],
        },
      ],
    },
  },
  ...(expiry ? { expiry } : {}),
});

/** Put what a previous session would have saved into IndexedDB, then restart. */
async function seedAndReload(page: Page, event: Record<string, unknown>): Promise<void> {
  await page.goto(HARNESS);
  await page.waitForFunction(() => '__transcriptCache' in window);
  await page.evaluate(
    (e) => (window as unknown as CacheWindow).__transcriptCache.saveEvents(e.chatId as string, [e]),
    event,
  );
  await page.reload();
}

test.describe('a question survives a real reload', () => {
  test('answered: comes back answered with the picks marked, not open and blank', async ({
    page,
  }) => {
    await seedAndReload(page, request());

    // Cold start paints the cached request: still open, as it really is.
    await expect(page.getByTestId('question-card')).toBeVisible();
    await page.getByTestId('question-option').filter({ hasText: 'Luxon' }).click();
    await page.getByTestId('question-submit').click();
    await expect(page.getByTestId('permission-outcome')).toHaveText('Answered');

    // The write is asynchronous; a reload mid-write is not what is under test.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const t = await (window as unknown as CacheWindow).__transcriptCache.loadTranscript(
            'chat_cache_question',
          );
          return t?.resolutions.length ?? 0;
        }),
      )
      .toBe(1);

    await page.reload();

    await expect(page.getByTestId('permission-outcome')).toHaveText('Answered');
    await expect(page.getByTestId('question-submit')).toHaveCount(0);
    const luxon = page.getByTestId('question-option').filter({ hasText: 'Luxon' });
    const dateFns = page.getByTestId('question-option').filter({ hasText: 'date-fns' });
    await expect(luxon).toHaveAttribute('data-selected', 'true');
    await expect(dateFns).toHaveAttribute('data-selected', 'false');
  });

  test('expired: comes back greyed out with no way to send', async ({ page }) => {
    await seedAndReload(page, request({ at: Date.now() - 5_000, windowMs: 60_000 }));

    await expect(page.getByTestId('question-countdown')).toHaveAttribute('data-expired', 'true');
    await expect(page.getByTestId('question-submit')).toBeDisabled();
  });
});
