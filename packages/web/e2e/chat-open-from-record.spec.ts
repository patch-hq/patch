import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { WireEvent } from '@patch/wire';
import { startRealStack, entryText, type RealStack } from './support/realStack.js';

// Opening a chat reads its history from the server's record alone (spec/03 §
// Chat history, spec/04 § Branching), against a REAL server and host with the
// real web app: a side thread's entries stay off the main transcript but are
// served for their own track, and a chat whose host is offline opens with its
// whole history. The host is never asked.

test.describe.configure({ mode: 'serial' });

let stack: RealStack;
let device = 0;

const BRANCHED = 'chat-branched';
const OFFLINE = 'chat-offline';
const ENTRIES = 30;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startRealStack();
  await stack.seedChat(BRANCHED, 3, 'branched chat');
  await stack.seedChat(OFFLINE, ENTRIES, 'offline chat');
});

test.afterAll(async () => {
  await stack?.close();
});

async function newDevice(
  browser: Browser,
): Promise<{ ctx: BrowserContext; page: Page; jwt: string }> {
  const jwt = await stack.credential(`open-from-record-${++device}`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((token) => {
    if (location.protocol === 'http:') window.localStorage.setItem('patch.credential.v1', token);
  }, jwt);
  return { ctx, page: await ctx.newPage(), jwt };
}

test("a side thread's entries stay off the main transcript and are served for their own track", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const root = 'branch-main';
  const side = 'branch-side';
  stack.harness.link.send({
    type: 'chat.branches',
    chatId: BRANCHED,
    activeBranchId: root,
    branches: [
      { branchId: root, parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 1 },
      {
        branchId: side,
        parentBranchId: root,
        forkFromSeq: 1,
        label: 'side 1',
        createdAt: 2,
        sideThread: true,
      },
    ],
  } as WireEvent);
  const entry = (seq: number, content: string, branchId: string): WireEvent =>
    ({
      type: 'chat.message',
      chatId: BRANCHED,
      role: 'assistant',
      content,
      seq,
      branchId,
    }) as WireEvent;
  stack.harness.link.send(entry(3, 'side-thread-answer', side));
  stack.harness.link.send(entry(4, 'main-track-after', root));

  const { ctx, page, jwt } = await newDevice(browser);
  try {
    await page.goto(`${stack.appUrl}/app/chats/${BRANCHED}`);
    await expect(page.getByText('main-track-after', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(entryText(0), { exact: true })).toBeAttached();
    await expect(page.getByText('side-thread-answer', { exact: true })).toHaveCount(0);

    const read = await page.evaluate(
      async ({ chatId, branchId, token }) => {
        const res = await fetch(`/api/chats/${chatId}/history?branchId=${branchId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const body = (await res.json()) as { events: Array<{ content?: string }> };
        return { status: res.status, contents: body.events.map((e) => e.content) };
      },
      { chatId: BRANCHED, branchId: side, token: jwt },
    );
    expect(read.status).toBe(200);
    expect(read.contents).toEqual([entryText(0), entryText(1), 'side-thread-answer']);
  } finally {
    await ctx.close();
  }
});

test('a chat whose host is offline opens with its whole history', async ({ browser }) => {
  test.setTimeout(120_000);
  // The host goes away for good: its link stops and does not redial.
  await stack.harness.link.close();
  await stack.harness.waitHostOffline();

  const { ctx, page } = await newDevice(browser);
  try {
    await page.goto(`${stack.appUrl}/app/chats/${OFFLINE}`);
    await expect(page.getByText(entryText(ENTRIES - 1), { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    for (let seq = 0; seq < ENTRIES; seq++) {
      await expect(page.getByText(entryText(seq), { exact: true })).toBeAttached();
    }
  } finally {
    await ctx.close();
  }
});
