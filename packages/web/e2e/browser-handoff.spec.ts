import { test, expect, type Page } from '@playwright/test';

// spec/14 § Browser hand-off. jsdom (BrowserHandoffPanel.test.tsx) proves the
// wiring; this proves the live view is really on screen with the real CSS at
// desktop AND phone widths: a small draggable preview, an expanded view where
// a click lands on the right page pixel, and hover, keys and Done reaching the host.
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

async function play(page: Page, handoff: boolean): Promise<void> {
  await page.evaluate(
    ({ pixel, handoff }) => {
      const store = (window as unknown as { __browserHandoffStore: Store }).__browserHandoffStore;
      store.getState().applyFrame('chat_bgtask', {
        tabId: 't1',
        data: pixel,
        width: 1280,
        height: 720,
        url: 'https://accounts.example.com/signin',
        title: 'Sign in',
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
    { pixel: PIXEL, handoff },
  );
}

const sent = (page: Page) =>
  page.evaluate(() => (window as unknown as { __wsSent: unknown[] }).__wsSent.slice());

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
  test.describe(`browser hand-off — ${name}`, () => {
    test.use({ viewport });

    test('says what the chat is browsing with Watch and Stop on screen, and Stop tells the host', async ({
      page,
    }) => {
      await page.goto(CHAT);
      await page.evaluate(() => {
        const store = (window as unknown as { __browserHandoffStore: Store }).__browserHandoffStore;
        store.getState().applyStatus({
          type: 'patch.browser_view.status',
          chatId: 'chat_bgtask',
          active: true,
          action: 'Clicking',
          tabs: [{ tabId: 't1', url: 'https://www.example.com/a?x=1', handedOff: false }],
        });
      });
      await expect(page.getByTestId('browser-status')).toHaveText(
        'Browsing example.com · Clicking',
      );
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
      await expect(page.getByTestId('browser-stop')).toHaveCount(0);
    });

    test('shows a small preview inside the window that drags without expanding', async ({
      page,
    }) => {
      await page.goto(CHAT);
      await play(page, true);
      const card = page.getByTestId('browser-handoff');
      await expect(card).toBeInViewport({ ratio: 1 });
      await expect(page.getByTestId('browser-handoff-title')).toHaveText('Sign in to Example');
      await expect.poll(() => drawn(page, 'browser-handoff-preview')).toBe(true);
      const box = (await card.boundingBox())!;
      // Small: well under half the window, so the chat stays usable behind it.
      expect(box.width * box.height).toBeLessThan((viewport.width * viewport.height) / 4);

      const grip = page.getByTestId('browser-handoff-title');
      const g = (await grip.boundingBox())!;
      await page.mouse.move(g.x + 10, g.y + g.height / 2);
      await page.mouse.down();
      await page.mouse.move(g.x - 60, g.y - 150, { steps: 5 });
      await page.mouse.up();
      const moved = (await card.boundingBox())!;
      expect(moved.y).toBeLessThan(box.y - 100);
      await expect(page.getByTestId('browser-live')).toHaveCount(0);
      await expect(card).toBeInViewport({ ratio: 1 });
    });

    test('expands to a large live tab where a click lands on the matching page pixel', async ({
      page,
    }) => {
      await page.goto(CHAT);
      await play(page, true);
      await page.getByTestId('browser-handoff-expand').click();
      await expect(page.getByTestId('browser-live')).toBeVisible();
      const canvas = page.getByTestId('browser-handoff-frame');
      await expect(canvas).toBeVisible();
      await expect.poll(() => drawn(page, 'browser-handoff-frame')).toBe(true);
      const box = (await canvas.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
      // The picture keeps the page's 16:9 shape, so its box is the picture.
      expect(Math.abs(box.width / box.height - 1280 / 720)).toBeLessThan(0.02);
      // Large: most of the window's width on a desktop, all of it on a phone.
      expect(box.width).toBeGreaterThan(viewport.width * 0.6);
      await expect(page.getByTestId('browser-handoff-done')).toBeInViewport();

      await canvas.click({ position: { x: box.width / 4, y: box.height / 2 } });
      const click = (await sent(page)).find(
        (e) => (e as { input?: { kind: string; action?: string } }).input?.action === 'click',
      ) as { input: { x: number; y: number }; handoffId: string };
      expect(click.handoffId).toBe('h1');
      expect(Math.abs(click.input.x - 320)).toBeLessThan(4);
      expect(Math.abs(click.input.y - 360)).toBeLessThan(4);

      await page.getByTestId('browser-live-minimise').click();
      await expect(page.getByTestId('browser-live')).toHaveCount(0);
      await expect(page.getByTestId('browser-handoff')).toBeVisible();
    });

    test('hover reaches the host as moves; typing and Enter as text and a key; Done as control', async ({
      page,
    }) => {
      await page.goto(CHAT);
      await play(page, true);
      await page.getByTestId('browser-handoff-expand').click();
      await expect(page.getByTestId('browser-handoff-keys')).toBeFocused();
      const canvas = page.getByTestId('browser-handoff-frame');
      const box = (await canvas.boundingBox())!;
      if (name === 'desktop') {
        await page.mouse.move(box.x + 20, box.y + 20);
        await page.mouse.move(box.x + 40, box.y + 40, { steps: 4 });
        await expect
          .poll(async () =>
            (await sent(page)).some(
              (e) => (e as { input?: { action?: string } }).input?.action === 'move',
            ),
          )
          .toBe(true);
      }
      await page.keyboard.type('hunter2');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Backspace');
      const inputs = (await sent(page))
        .map((e) => (e as { input?: { kind: string; text?: string; key?: string } }).input)
        .filter((i) => i && i.kind !== 'pointer');
      expect(
        inputs
          .filter((i) => i!.kind === 'text')
          .map((i) => i!.text)
          .join(''),
      ).toBe('hunter2');
      expect(inputs.filter((i) => i!.kind === 'key').map((i) => i!.key)).toEqual([
        'Enter',
        'Backspace',
      ]);

      await page.getByTestId('browser-handoff-done').click();
      expect((await sent(page)).at(-1)).toMatchObject({
        type: 'patch.browser_handoff.control',
        handoffId: 'h1',
        action: 'done',
      });
    });

    test('goes away when the host says the hand-off ended', async ({ page }) => {
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
      });
      await expect(page.getByTestId('browser-handoff')).toHaveCount(0);
    });
  });
}
