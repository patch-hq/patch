import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import { startRealStack, entryText, type RealStack } from './support/realStack.js';

// The load targets (spec/05 § Loading, spec/19 § Load targets), against a REAL
// server and host with the real web app. Required checks, run in the gate.

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1280, height: 800 } });

let stack: RealStack;
let device = 0;

const LONG = 'chat-long';
const LONG_ENTRIES = 10_000;
const SMALL = 'chat-small';

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startRealStack();
  await stack.seedChat(SMALL, 5, 'small chat');
  await stack.seedChat(LONG, LONG_ENTRIES, 'long chat');
  // The dev server compiles a module the first time it is asked for it. Pay
  // for that here, so no target below measures a cold compile.
  const { ctx, page } = await newDevice(browser);
  try {
    await page.goto(`${stack.appUrl}/app/chats/${SMALL}`);
    await expect(page.getByText(entryText(4), { exact: true })).toBeVisible({ timeout: 120_000 });
  } finally {
    await ctx.close();
  }
});

test.afterAll(async () => {
  await stack?.close();
});

/** A new browser profile: it holds nothing until it is used. */
async function newDevice(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const credential = await stack.credential(`load-target-${++device}`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((jwt) => {
    // Opaque documents (about:blank) refuse storage; only the app's origin needs it.
    if (location.protocol === 'http:') window.localStorage.setItem('patch.credential.v1', jwt);
  }, credential);
  return { ctx, page: await ctx.newPage() };
}

const rowLink = (page: Page, chatId: string) => page.locator(`a[href$="/chats/${chatId}"]`).first();

/** Every socket the page opens, so a test can hold or cut the connection. */
function trackSockets(
  page: Page,
  opts: { reach: () => boolean; refuse?: () => boolean },
): Promise<{ live: WebSocketRoute[] }> {
  const live: WebSocketRoute[] = [];
  return page
    .routeWebSocket(/\/ws$/, (ws) => {
      if (!opts.reach()) return; // the server never answers: no connection to it at all
      if (opts.refuse?.()) {
        void ws.close(); // the link is down: every dial is dropped
        return;
      }
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(m));
      ws.onClose(() => {
        const i = live.indexOf(ws);
        if (i >= 0) live.splice(i, 1);
      });
      live.push(ws);
    })
    .then(() => ({ live }));
}

test('the chat list and a followed chat render from the device copy while the server answers nothing', async ({
  browser,
}) => {
  const { ctx, page } = await newDevice(browser);
  try {
    // First visit, server reachable: the device comes to hold the list and the
    // entries of the chat it opened.
    await page.goto(`${stack.appUrl}/app/chats/${SMALL}`);
    await expect(page.getByText(entryText(4))).toBeVisible();
    await expect(rowLink(page, LONG)).toBeVisible();
    // The copy is written behind a short debounce; wait until it is on disk.
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await indexedDB.databases())
            .map((d) => d.name)
            .sort()
            .join(','),
        ),
      )
      .toContain('patch-chatlist');
    await page.waitForTimeout(1500);

    // Second visit: every request and the socket go nowhere and never answer.
    await page.close();
    const blind = await ctx.newPage();
    await blind.route(
      (url) => url.pathname.startsWith('/api/'),
      () => new Promise(() => undefined),
    );
    await trackSockets(blind, { reach: () => false });
    await blind.goto(`${stack.appUrl}/app/chats/${SMALL}`);
    await expect(rowLink(blind, SMALL)).toBeVisible();
    await expect(rowLink(blind, LONG)).toBeVisible();
    await expect(blind.getByText(entryText(4))).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test('a chat of 10,000 entries shows its last screen within a second of opening, from a device that holds nothing for it', async ({
  browser,
}) => {
  const { ctx, page } = await newDevice(browser);
  try {
    await page.goto(`${stack.appUrl}/app/chats/${SMALL}`);
    await expect(rowLink(page, LONG)).toBeVisible();
    // Timed in the page, from the click event to the last entry in the document:
    // the clock must not include Playwright's own time to find and click the row.
    const last = entryText(LONG_ENTRIES - 1);
    await page.evaluate((text) => {
      const w = window as unknown as { __opened?: number; __shown?: number };
      document.addEventListener(
        'click',
        () => {
          w.__opened = performance.now();
          const look = (): void => {
            if (document.body.textContent?.includes(text)) w.__shown = performance.now();
            else requestAnimationFrame(look);
          };
          look();
        },
        { capture: true, once: true },
      );
    }, last);
    await rowLink(page, LONG).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __shown?: number }).__shown ?? null))
      .not.toBeNull();
    const took = await page.evaluate(() => {
      const w = window as unknown as { __opened: number; __shown: number };
      return w.__shown - w.__opened;
    });
    expect(took, `last screen took ${Math.round(took)}ms to render`).toBeLessThan(1000);
    // It is the end of the chat, and only a screen of it: the older entries are
    // paged in as the reader scrolls up, not loaded up front.
    await expect(page.getByText(entryText(0), { exact: true })).toHaveCount(0);
    expect(await page.locator('[data-testid="msg"]').count()).toBeLessThan(500);
  } finally {
    await ctx.close();
  }
});

test('nothing shown is lost across a reconnect, and nothing arrives twice', async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  try {
    let linkDown = false;
    const sockets = await trackSockets(page, { reach: () => true, refuse: () => linkDown });
    await page.goto(`${stack.appUrl}/app/chats/${SMALL}`);
    await expect(page.getByText(entryText(4), { exact: true })).toBeVisible();
    await expect.poll(() => sockets.live.length).toBeGreaterThan(0);

    // Mid-turn: entries are arriving, the connection drops, entries keep arriving.
    stack.say(SMALL, 5, 5);
    await expect(page.getByText(entryText(9), { exact: true })).toBeVisible();
    linkDown = true;
    for (const ws of [...sockets.live]) await ws.close();
    stack.say(SMALL, 10, 10);
    // Entries that arrived while the device could not hear are caught up on
    // reconnect, and the ones it already showed are not shown again.
    await page.waitForTimeout(1500);
    linkDown = false;
    await expect(page.getByText(entryText(19), { exact: true })).toBeVisible();
    stack.say(SMALL, 20, 5);
    await expect(page.getByText(entryText(24), { exact: true })).toBeVisible();

    const shown = await page
      .locator('[data-testid="msg"]')
      .evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    const seqs = shown
      .map((t) => /entry-(\d{6})/.exec(t)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i));
  } finally {
    await ctx.close();
  }
});

test('nothing renders empty or finished before the server has answered', async ({ browser }) => {
  const { ctx, page } = await newDevice(browser);
  try {
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      () => new Promise(() => undefined),
    );
    await trackSockets(page, { reach: () => false });
    await page.goto(`${stack.appUrl}/app/chats/${SMALL}`);
    await expect(page.getByTestId('sidebar-skeleton')).toBeVisible();
    // Give any wrongly drawn empty state time to appear.
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('sidebar-skeleton')).toBeVisible();
    await expect(page.getByTestId('no-chat')).toHaveCount(0);
    await expect(page.getByTestId('empty-chat')).toHaveCount(0);
    await expect(page.getByTestId('attention-empty')).toHaveCount(0);
    await expect(page.locator('[data-testid="msg"]')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
