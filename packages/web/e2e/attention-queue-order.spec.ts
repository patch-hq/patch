import { test, expect } from '@playwright/test';
import { chooseSidebarView } from './sidebarView';

// The needs-attention list keeps the same stable order as the main chat list:
// the user's own last activity, newest first. An agent-driven update (which
// bumps lastUpdated only) must never move a row — real browser + real
// CSS/render order.
const HARNESS = '/app/dev-harness.html';

test.describe('needs-attention queue order', () => {
  test('orders by user activity, and an agent update does not move a row', async ({ page }) => {
    await page.goto(HARNESS);
    await chooseSidebarView(page, 'unread');

    const first = page.getByTestId('chat-row-chat_long_text');
    const second = page.getByTestId('chat-row-chat_md');
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();

    const merge = async (chatId: string, name: string, over: Record<string, number>) =>
      page.evaluate(
        ([id, n, o]) => {
          const w = window as unknown as {
            __store: { getState: () => { mergeChats: (rows: unknown[]) => void } };
          };
          w.__store.getState().mergeChats([
            {
              chatId: id,
              hostId: 'd1',
              permissionMode: 'auto',
              name: n,
              folder: '/home/tom/projects/portfolio',
              activity: 'idle',
              status: 'active',
              pinned: false,
              pinnedAt: null,
              ...(o as object),
            },
          ]);
        },
        [chatId, name, over] as const,
      );

    const rowOrder = async (): Promise<string[]> =>
      page
        .locator('[data-testid^="chat-row-"]')
        .evaluateAll((els) =>
          els.map((el) => el.getAttribute('data-testid')).filter((id): id is string => id !== null),
        );

    // chat_long_text has the more recent user activity, so it comes first.
    await merge('chat_long_text', 'long-text-fixture', { lastUserActivity: 2000, lastUpdated: 0 });
    await merge('chat_md', 'md-fixture', { lastUserActivity: 1000, lastUpdated: 5 });
    const before = await rowOrder();
    expect(before.indexOf('chat-row-chat_long_text')).toBeLessThan(
      before.indexOf('chat-row-chat_md'),
    );

    // An agent update to chat_md bumps lastUpdated only; the order is unchanged.
    await merge('chat_md', 'md-fixture', { lastUserActivity: 1000, lastUpdated: Date.now() });
    const after = await rowOrder();
    expect(after).toEqual(before);
  });
});
