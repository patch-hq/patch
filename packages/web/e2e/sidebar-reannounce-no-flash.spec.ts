import { test, expect } from '@playwright/test';

// Todoist 6hr8xGJjRPmrfXqF: on a server restart or host reload, chats flashed
// into the sidebar and straight back out. The reconnecting host re-announces
// every chat it holds — archived ones too — as `chat.spawned` then
// `chat.state`, and the store applies those in separate batches whenever a
// batch boundary falls between them. This replays exactly that split, with a
// MutationObserver watching the real sidebar for any frame the archived chat
// is drawn in the active list.

const HARNESS = '/app/dev-harness.html';

test('a reconnecting host re-announcing an archived chat never draws it in the list', async ({
  page,
}) => {
  await page.goto(HARNESS);
  await expect(page.getByTestId('sb-scroll')).toBeVisible();
  const flashed = await page.evaluate(async () => {
    type S = { getState: () => { applyEvents: (e: unknown[]) => void } };
    const store = (window as unknown as { __store: S }).__store;
    const scroll = document.querySelector('[data-testid="sb-scroll"]')!;
    let seen = false;
    const look = (): void => {
      if (scroll.querySelector('[data-testid="chat-row-reannounce-arch"]')) seen = true;
    };
    const obs = new MutationObserver(look);
    obs.observe(scroll, { childList: true, subtree: true });
    const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
    for (let i = 0; i < 3; i++) {
      store.getState().applyEvents([
        {
          type: 'chat.spawned',
          hostId: 'd1',
          chatId: 'reannounce-arch',
          folder: '/tmp/reannounce',
        },
      ]);
      look();
      await frame();
      await frame();
      store.getState().applyEvents([
        {
          type: 'chat.state',
          chatId: 'reannounce-arch',
          hostId: 'd1',
          folder: '/tmp/reannounce',
          activity: 'idle',
          permissionMode: 'auto',
          status: 'archived',
          lastUpdated: Date.now(),
        },
      ]);
      await frame();
      look();
    }
    obs.disconnect();
    return seen;
  });
  expect(flashed).toBe(false);
});
