import { test, expect, type Page } from '@playwright/test';

// spec/04 § Spawn: the same path on two hosts is two directories, and a project
// whose name another host also uses is headed `name (host)` (spec/14 § Sidebar).
const HARNESS = '/app/dev-harness.html?chat=chat_md&hosts=two';

async function addChat(
  page: Page,
  chat: { chatId: string; hostId: string; folder: string },
): Promise<void> {
  await page.waitForFunction(() => '__store' in window);
  await page.evaluate((c) => {
    const st = (
      window as unknown as {
        __store: {
          getState: () => {
            chats: Record<string, Record<string, unknown>>;
            hydrate: (rows: unknown[]) => void;
          };
        };
      }
    ).__store.getState();
    const base = Object.values(st.chats)[0]!;
    st.hydrate([
      ...Object.values(st.chats),
      {
        ...base,
        chatId: c.chatId,
        hostId: c.hostId,
        folder: c.folder,
        name: c.chatId,
        pinned: false,
        pinnedAt: null,
        activity: 'idle',
        status: 'active',
      },
    ]);
  }, chat);
}

test.describe('sidebar project headers across hosts', () => {
  test('a name used on two hosts names its host; a name used once does not', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();
    await addChat(page, {
      chatId: 'mac_bus',
      hostId: 'd2',
      folder: '/Users/dev/projects/bus',
    });

    const labels = page.locator('.folder-head-label');
    await expect(labels.filter({ hasText: /^bus \(mac\)$/ })).toHaveCount(1);
    await expect(labels.filter({ hasText: /^bus \(dev-host\)$/ })).toHaveCount(1);
    // `portfolio` lives on one host only, so it stays a bare name.
    await expect(labels.filter({ hasText: /^portfolio$/ })).toHaveCount(1);
  });

  test('the same path on two hosts is two projects, not one merged list', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();
    await addChat(page, {
      chatId: 'mac_same_path',
      hostId: 'd2',
      folder: '/home/tom/projects/bus',
    });

    const own = page.locator('.sb-folder', { hasText: /^bus \(dev-host\)/ });
    const other = page.locator('.sb-folder', { hasText: /^bus \(mac\)/ });
    await expect(own.getByTestId('chat-row-chat_bus')).toBeVisible();
    await expect(own.getByTestId('chat-row-mac_same_path')).toHaveCount(0);
    await expect(other.getByTestId('chat-row-mac_same_path')).toBeVisible();
  });
});
