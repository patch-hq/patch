import { test, expect, type Page } from '@playwright/test';

// A turn held because its host is in a dark wake (a Mac with its lid shut)
// says so in the transcript, names the host, and goes when the hold ends.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

async function hold(page: Page, since: number | null): Promise<void> {
  await page.evaluate((s) => {
    const w = window as unknown as {
      __store: {
        getState: () => {
          chats: Record<string, { hostId: string; folder: string }>;
          applyEvent: (e: unknown) => void;
        };
      };
      __presenceStore: { getState: () => { setHostReport: (e: unknown) => void } };
    };
    const row = w.__store.getState().chats['chat_md']!;
    w.__presenceStore.getState().setHostReport({
      type: 'host.host',
      hostId: row.hostId,
      hostName: 'studio-mac',
      backends: [],
      components: [],
    });
    w.__store.getState().applyEvent({
      type: 'chat.state',
      chatId: 'chat_md',
      hostId: row.hostId,
      activity: 'idle',
      folder: row.folder,
      lastUpdated: Date.now(),
      permissionMode: 'bypassPermissions',
      waitingForWakeSince: s,
    });
  }, since);
}

test('a turn held for a sleeping host says so, and the notice goes when it wakes', async ({
  page,
}) => {
  await page.goto(HARNESS);
  await expect(page.getByTestId('wake-hold-bar')).toHaveCount(0);
  await hold(page, Date.now());
  const bar = page.getByTestId('wake-hold-bar');
  await expect(bar).toHaveText(
    'Waiting for studio-mac to wake. This turn runs as soon as it does.',
  );
  await bar.screenshot({ path: 'test-results/wake-hold.png' });
  await hold(page, null);
  await expect(bar).toHaveCount(0);
});
