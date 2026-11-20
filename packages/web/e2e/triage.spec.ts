import { test, expect, type Page } from '@playwright/test';

// Triage (spec/14 § Triage): one waiting chat at a time, reply, next. Real
// browser + real CSS, at desktop and phone width.
const HARNESS = '/app/dev-harness.html?route=/triage&ws=fake';

type Store = {
  getState: () => { chats: Record<string, unknown>; timelines: Record<string, unknown> };
  setState: (s: unknown) => void;
};

const row = (chatId: string, name: string, lastUpdated: number) => ({
  chatId,
  hostId: 'd1',
  name,
  preview: null,
  statusKind: null,
  statusDeclared: null,
  todos: [],
  folder: '/home/tom/projects/portfolio',
  chatStatus: { state: 'idle', since: 0 },
  status: 'active',
  pinned: false,
  disabled: false,
  lastUpdated,
  lastSeq: 5,
  lastReadSeq: 1,
  pendingPermissions: [],
});
const msg = (content: string) => [{ kind: 'message', role: 'assistant', content, seq: 3 }];

async function seed(page: Page, ids: [string, string, number][]): Promise<void> {
  await page.evaluate((list) => {
    const store = (window as unknown as { __store: Store }).__store;
    const chats: Record<string, unknown> = {};
    const timelines: Record<string, unknown> = {};
    for (const [id, name, at] of list) {
      chats[id] = {
        chatId: id,
        hostId: 'd1',
        name,
        preview: null,
        statusKind: null,
        statusDeclared: null,
        todos: [],
        folder: '/home/tom/projects/portfolio',
        chatStatus: { state: 'idle', since: 0 },
        status: 'active',
        pinned: false,
        disabled: false,
        lastUpdated: at,
        lastSeq: 5,
        lastReadSeq: 1,
        pendingPermissions: [],
      };
      timelines[id] = [
        { kind: 'message', role: 'assistant', content: `Full text of ${name}`, seq: 3 },
      ];
    }
    store.setState({ chats, timelines });
  }, ids);
}
void row;
void msg;

for (const [label, size] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 412, height: 900 }],
] as const) {
  test.describe(`triage — ${label}`, () => {
    test.use({ viewport: size });

    test('works through the queue one chat at a time, newest at the end', async ({ page }) => {
      await page.goto(HARNESS);
      await seed(page, [
        ['t_a', 'first chat', 10],
        ['t_b', 'second chat', 20],
      ]);
      await expect(page.getByTestId('triage-title')).toHaveText('first chat');
      await expect(page.getByTestId('triage-message')).toContainText('Full text of first chat');

      // A chat that finishes while you work joins the end, not the front.
      await page.evaluate(() => {
        const store = (window as unknown as { __store: Store }).__store;
        const s = store.getState();
        store.setState({
          chats: {
            ...s.chats,
            t_c: {
              ...(s.chats['t_a'] as object),
              chatId: 't_c',
              name: 'third chat',
              lastUpdated: 30,
            },
          },
          timelines: {
            ...s.timelines,
            t_c: [
              { kind: 'message', role: 'assistant', content: 'Full text of third chat', seq: 3 },
            ],
          },
        });
      });
      await expect(page.getByTestId('triage-count')).toHaveText('3 waiting');
      await expect(page.getByTestId('triage-title')).toHaveText('first chat');

      // The reply box and Send are on screen without scrolling the page.
      const send = page.getByTestId('triage-send');
      await expect(send).toBeInViewport();
      await expect(send).toBeDisabled();

      for (const name of ['second chat', 'third chat']) {
        await page.getByTestId('triage-input').fill('go ahead');
        await send.click();
        await expect(page.getByTestId('triage-title')).toHaveText(name);
        await expect(page.getByTestId('triage-input')).toHaveValue('');
      }
      await page.getByTestId('triage-input').fill('last one');
      await send.click();
      // Each reply really went out, to the chat it answered.
      const sent = await page.evaluate(() =>
        JSON.stringify((window as unknown as { __wsSent: unknown[] }).__wsSent),
      );
      for (const id of ['t_a', 't_b', 't_c']) expect(sent).toContain(id);
      expect(sent).toContain('go ahead');
      expect(sent).toContain('last one');
      await expect(page.getByTestId('triage-empty')).toBeVisible();
    });
  });
}
