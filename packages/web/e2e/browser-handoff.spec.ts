import { test, expect, type Page } from '@playwright/test';

// spec/14 § Browser. jsdom (BrowserHandoffPanel.test.tsx) proves the wiring;
// this proves the browser is really on screen with the real CSS at desktop AND
// phone widths: the bar, a small draggable preview, and the large view — a
// pane beside the chat on a desktop, the whole screen on a phone — where a
// press lands on the right page pixel and keys and Done reach the host.
const CHAT = '/app/dev-harness.html?chat=chat_bgtask';

// A real JPEG-ish picture is not needed: a 1x1 GIF scaled up by CSS is enough
// to measure where a tap lands.
const PIXEL = 'R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=';

type Store = {
  getState(): {
    applyFrame(c: string, f: unknown): void;
    applyState(e: unknown): void;
    applyStatus(e: unknown): void;
  };
};

const STATUS = {
  type: 'patch.browser_view.status',
  chatId: 'chat_bgtask',
  active: true,
  action: 'Clicking',
  tabs: [{ tabId: 't1', url: 'https://accounts.example.com/signin?x=1', handedOff: false }],
};

async function play(page: Page, handoff: boolean): Promise<void> {
  await page.evaluate(
    ({ pixel, handoff, status }) => {
      const store = (window as unknown as { __browserHandoffStore: Store }).__browserHandoffStore;
      store.getState().applyStatus({ ...status, since: Date.now() - 61_000 });
      store.getState().applyFrame('chat_bgtask', {
        tabId: 't1',
        data: pixel,
        width: 1280,
        height: 720,
        url: 'https://accounts.example.com/signin',
        title: 'Sign in',
        inputVersion: 2,
        canGoBack: false,
        canGoForward: false,
      });
      if (handoff) {
        store.getState().applyState({
          type: 'patch.browser_handoff.state',
          chatId: 'chat_bgtask',
          handoffId: 'h1',
          tabId: 't1',
          status: 'waiting',
          reason: 'Sign in to Example',
          startedAt: 1,
        });
      }
    },
    { pixel: PIXEL, handoff, status: STATUS },
  );
}

const sent = (page: Page) =>
  page.evaluate(() => (window as unknown as { __wsSent: unknown[] }).__wsSent.slice());

const viewInputs = async (page: Page) =>
  (await sent(page))
    .filter((e) => (e as { type: string }).type === 'patch.browser_view.input')
    .map((e) => (e as { input: Record<string, unknown> }).input);

/** The frame is really drawn: the picture decoded, not just a box of the right size. */
const drawn = (page: Page, testId: string) =>
  page.evaluate((id) => {
    const img = document.querySelector(`[data-testid="${id}"]`) as HTMLImageElement | null;
    return img !== null && img.complete && img.naturalWidth > 0;
  }, testId);

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 780 }],
] as const) {
  test.describe(`agent browser — ${name}`, () => {
    test.use({ viewport });

    test('the bar says what the agent is doing with Watch and Stop on screen, and Stop tells the host', async ({
      page,
    }) => {
      await page.goto(CHAT);
      await page.evaluate((status) => {
        const store = (window as unknown as { __browserHandoffStore: Store }).__browserHandoffStore;
        store.getState().applyStatus(status);
      }, STATUS);
      await expect(page.getByTestId('browser-status')).toHaveText('Using browser · Clicking');
      await expect(page.getByTestId('browser-watch')).toBeInViewport();
      await expect(page.getByTestId('browser-stop')).toBeInViewport();
      const bar = (await page.getByTestId('browser-watch-bar').boundingBox())!;
      expect(bar.x + bar.width).toBeLessThanOrEqual(viewport.width + 0.5);
      await page.getByTestId('browser-stop').click();
      expect(await sent(page)).toContainEqual({
        type: 'patch.browser_view.stop',
        chatId: 'chat_bgtask',
      });
      // The host closes the tabs and says so: the bar goes.
      await page.evaluate(() => {
        const store = (window as unknown as { __browserHandoffStore: Store }).__browserHandoffStore;
        store.getState().applyStatus({
          type: 'patch.browser_view.status',
          chatId: 'chat_bgtask',
          active: false,
          tabs: [],
        });
      });
      await expect(page.getByTestId('browser-watch-bar')).toHaveCount(0);
    });

    test('the agent asking opens a small preview by itself, which drags without expanding', async ({
      page,
    }) => {
      await page.goto(CHAT);
      await play(page, true);
      const card = page.getByTestId('browser-handoff');
      await expect(card).toBeInViewport({ ratio: 1 });
      await expect(page.getByTestId('browser-mini-line')).toHaveText('Sign in to Example');
      await expect(page.getByTestId('browser-drive-chip')).toHaveText('Needs you');
      await expect.poll(() => drawn(page, 'browser-handoff-preview')).toBe(true);
      const box = (await card.boundingBox())!;
      // Small: well under half the window, so the chat stays usable behind it.
      expect(box.width * box.height).toBeLessThan((viewport.width * viewport.height) / 3);

      const grip = page.getByTestId('browser-handoff-title');
      const g = (await grip.boundingBox())!;
      await page.mouse.move(g.x + 10, g.y + g.height / 2);
      await page.mouse.down();
      await page.mouse.move(g.x - 40, g.y - 150, { steps: 5 });
      await page.mouse.up();
      const moved = (await card.boundingBox())!;
      expect(moved.y).toBeLessThan(box.y - 100);
      await expect(page.getByTestId('browser-live')).toHaveCount(0);
      await expect(card).toBeInViewport({ ratio: 1 });
    });

    test('opens large where a press lands on the matching page pixel, as a pane on a desktop and the whole screen on a phone', async ({
      page,
    }) => {
      await page.goto(CHAT);
      await play(page, false);
      await page.getByTestId('browser-watch').click();
      await page.getByTestId('browser-handoff-expand').click();
      const live = page.getByTestId('browser-live');
      await expect(live).toBeVisible();
      await expect.poll(() => drawn(page, 'browser-handoff-frame')).toBe(true);
      const view = (await live.boundingBox())!;
      if (name === 'desktop') {
        // Beside the chat, not over it: the composer is still on screen and the view takes most of the width.
        await expect(page.getByTestId('composer-input').first()).toBeInViewport();
        expect(view.width).toBeGreaterThan(viewport.width * 0.4);
        expect(view.x).toBeGreaterThan(viewport.width * 0.3);
      } else {
        expect(view.width).toBeGreaterThanOrEqual(viewport.width - 0.5);
        expect(view.height).toBeGreaterThanOrEqual(viewport.height - 0.5);
      }
      // The host is told the view's size and pixel ratio, so the page is laid out for it.
      await expect
        .poll(async () =>
          (await sent(page)).some(
            (e) =>
              (e as { type: string }).type === 'patch.browser_view.watch' &&
              ((e as { viewport?: { width: number } }).viewport?.width ?? 0) > 200,
          ),
        )
        .toBe(true);

      const pic = (await page.getByTestId('browser-surface').boundingBox())!;
      expect(Math.abs(pic.width / pic.height - 1280 / 720)).toBeLessThan(0.02);
      await page.mouse.click(pic.x + pic.width / 4, pic.y + pic.height / 2);
      const down = (await viewInputs(page)).find(
        (i) => i.kind === 'pointer' && i.action === 'down',
      ) as {
        x: number;
        y: number;
      };
      expect(Math.abs(down.x - 320)).toBeLessThan(4);
      expect(Math.abs(down.y - 360)).toBeLessThan(4);
      // Pressing the page took it over: the host is told who has it by the status that follows.
      expect((await viewInputs(page)).some((i) => i.kind === 'pointer' && i.action === 'up')).toBe(
        true,
      );

      await page
        .getByTestId(name === 'desktop' ? 'browser-live-close' : 'browser-live-minimise')
        .click();
      await expect(page.getByTestId('browser-live')).toHaveCount(0);
      await expect(page.getByTestId('browser-watch-bar')).toBeVisible();
    });

    test('typing and Enter reach the page as text and a key; Done ends the hand-off', async ({
      page,
    }) => {
      await page.goto(CHAT);
      await play(page, true);
      await page.getByTestId('browser-handoff-expand').click();
      await expect(page.getByTestId('browser-handoff-keys')).toBeFocused();
      if (name === 'desktop') {
        const pic = (await page.getByTestId('browser-surface').boundingBox())!;
        await page.mouse.move(pic.x + 20, pic.y + 20);
        await page.mouse.move(pic.x + 40, pic.y + 40, { steps: 4 });
        await expect
          .poll(async () => (await viewInputs(page)).some((i) => i.action === 'move'))
          .toBe(true);
        await page.getByTestId('browser-handoff-keys').focus();
      }
      await page.keyboard.type('hunter2');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Backspace');
      const typed = (await viewInputs(page)).filter((i) => i.kind !== 'pointer');
      expect(
        typed
          .filter((i) => i.kind === 'text')
          .map((i) => i.text)
          .join(''),
      ).toBe('hunter2');
      expect(typed.filter((i) => i.kind === 'key').map((i) => i.key)).toEqual([
        'Enter',
        'Backspace',
      ]);

      await page.getByTestId('browser-handoff-done').first().click();
      expect((await sent(page)).at(-1)).toMatchObject({
        type: 'patch.browser_handoff.control',
        handoffId: 'h1',
        action: 'done',
      });
    });

    test('goes away when the host says the hand-off ended and nothing is open', async ({
      page,
    }) => {
      await page.goto(CHAT);
      await play(page, true);
      await expect(page.getByTestId('browser-handoff')).toBeVisible();
      await page.evaluate(() => {
        const store = (window as unknown as { __browserHandoffStore: Store }).__browserHandoffStore;
        store.getState().applyState({
          type: 'patch.browser_handoff.state',
          chatId: 'chat_bgtask',
          handoffId: 'h1',
          tabId: 't1',
          status: 'ended',
          reason: 'x',
          startedAt: 1,
          outcome: 'done',
        });
        store.getState().applyStatus({
          type: 'patch.browser_view.status',
          chatId: 'chat_bgtask',
          active: false,
          tabs: [],
        });
      });
      await expect(page.getByTestId('browser-handoff')).toHaveCount(0);
    });
  });
}
