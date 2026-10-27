import { test, expect } from '@playwright/test';

// Todoist 6hr8xGJjRPmrfXqF: chats flickered out of the sidebar when the server
// restarted or a host reloaded. A reconnect refetches `GET /api/chats`, which
// leaves out archived/hidden/snoozed chats; the store used to rebuild its map
// from that snapshot alone, dropping those rows until their section refilled.
// This replays the refetch (same entry point as the real useQuery) several
// times, as a server restart and a host reload each cause, while watching the
// store and the DOM for any moment a row is missing.

const HARNESS = '/app/dev-harness.html';

test('a server restart and a host reload never drop a sidebar row', async ({ page }) => {
  await page.goto(HARNESS);
  const missing = await page.evaluate(async () => {
    type S = {
      getState: () => {
        chats: Record<string, unknown>;
        hydrate: (r: unknown[]) => void;
        mergeChats: (r: unknown[]) => void;
      };
      subscribe: (fn: () => void) => () => void;
    };
    const store = (window as unknown as { __store: S }).__store;
    const mk = (chatId: string, extra: Record<string, unknown> = {}) => ({
      chatId,
      hostId: 'd1',
      permissionMode: 'auto',
      name: chatId,
      folder: '/tmp/reconnect-e2e',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: Date.now(),
      ...extra,
    });
    const active = [mk('rc-a'), mk('rc-b')];
    const cold = [
      mk('rc-arch', { status: 'archived' }),
      mk('rc-hid', { hidden: true }),
      mk('rc-snz', { snoozedUntil: Date.now() + 3_600_000 }),
    ];
    store.getState().hydrate(active);
    store.getState().mergeChats(cold);
    const want = ['rc-a', 'rc-b', 'rc-arch', 'rc-hid', 'rc-snz'];
    const gaps: string[] = [];
    const check = () => {
      const have = store.getState().chats;
      for (const id of want) if (!(id in have)) gaps.push(id);
    };
    const unsub = store.subscribe(check);
    // Server restart, then host reload: each ends in a fresh snapshot of the
    // same active list, with the WS replay merging rows in between.
    for (let i = 0; i < 4; i++) {
      store.getState().hydrate(active);
      store.getState().mergeChats(active);
      await new Promise((r) => setTimeout(r, 50));
    }
    unsub();
    return gaps;
  });
  expect(missing).toEqual([]);
  await expect(page.getByTestId('chat-row-rc-a')).toBeVisible();
  await expect(page.getByTestId('chat-row-rc-b')).toBeVisible();
});
