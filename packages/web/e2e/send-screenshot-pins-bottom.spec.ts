import { test, expect } from '@playwright/test';

// Todoist: "patch - when a message has a screenshot and sends it doesn't go all
// the way to the bottom" (spec/14 § Main chat panel — Scroll position). An
// image has no height until it loads, so the pin on send lands short of the
// final bottom; the transcript must follow the image growing in.

const CHAT = 'chat_scroll';
// A tall 400x800 image, served after a delay.
const IMG_W = 400;
const IMG_H = 800;

test.use({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true });

test('sending a message with a slow-loading screenshot ends flush with the bottom', async ({
  page,
}) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${IMG_W}" height="${IMG_H}"><rect width="100%" height="100%" fill="#789"/></svg>`;
  await page.route('**/api/chats/*/attachment/**', async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
  });

  await page.goto(`/app/dev-harness.html?chat=${CHAT}`);
  const stream = page.locator('.chat-stream');
  const gap = () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(gap, { timeout: 4000 }).toBeLessThan(2);

  await page.evaluate(() => {
    const store = (
      window as unknown as {
        __store: { getState: () => { addLocalMessage: (...a: unknown[]) => void } };
      }
    ).__store;
    store
      .getState()
      .addLocalMessage('chat_scroll', 'look at this', 'local_shot', undefined, undefined, {
        localAttachments: [
          { name: 'shot.png', kind: 'image', url: '/api/chats/chat_scroll/attachment/att1' },
        ],
      });
    // The upload lands a beat later: the "Uploading" line goes, refs arrive.
    setTimeout(() => {
      const st = (window as any).__store.getState();
      st.patchLocalMessage('chat_scroll', 'local_shot', {
        upload: undefined,
        attachments: [{ id: 'att1', name: 'shot.png', kind: 'image' }],
      });
    }, 300);
    setTimeout(() => {
      (window as any).__store.getState().applyEvent({
        type: 'chat.message',
        chatId: 'chat_scroll',
        role: 'user',
        content: 'look at this',
        localId: 'local_shot',
        seq: 99000,
        createdAt: Date.now(),
      });
    }, 900);
  });

  await expect(page.getByTestId('msg-attachment-img')).toBeVisible();
  await page.waitForFunction(() => {
    const i = document.querySelector('.msg-attachment-img') as HTMLImageElement | null;
    return !!i && i.complete && i.naturalHeight > 0;
  });
  await page.waitForTimeout(1500);
  await expect.poll(gap, { timeout: 4000 }).toBeLessThan(2);
});

// The same bug, with the thing that actually produced it: a chat opened at a
// message (a `?seq=` jump, or a restore of a read position) keeps re-centring
// on that message through the transcript's late layout, and that re-centre
// RETURNS from the ResizeObserver before the follow-mode pin. A text send was
// unaffected — nothing grows after it — but a screenshot's image decodes
// inside the settle window, and the fire it caused re-centred on the jump
// instead of re-pinning. The send must stand the jump down.
test('a send while a ?seq= jump is still settling still ends flush with the bottom', async ({
  page,
}) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${IMG_W}" height="${IMG_H}"><rect width="100%" height="100%" fill="#789"/></svg>`;
  await page.route('**/api/chats/*/attachment/**', async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
  });

  await page.goto(
    `/app/dev-harness.html?chat=${CHAT}&route=${encodeURIComponent(`/chats/${CHAT}?seq=5`)}`,
  );
  const stream = page.locator('.chat-stream');
  const gap = () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  // The jump has landed: we are parked mid-transcript, not at the bottom.
  await expect(page.locator('.chat-stream [data-testid="msg"][data-seq="5"]')).toHaveClass(
    /msg-jump-target/,
  );
  expect(await gap()).toBeGreaterThan(50);

  await page.evaluate(() => {
    const st = (window as any).__store.getState();
    st.addLocalMessage('chat_scroll', 'look at this', 'local_shot2', undefined, undefined, {
      localAttachments: [
        { name: 'shot.png', kind: 'image', url: '/api/chats/chat_scroll/attachment/att2' },
      ],
    });
  });

  await expect(page.getByTestId('msg-attachment-img')).toBeVisible();
  await page.waitForFunction(() => {
    const i = document.querySelector('.msg-attachment-img') as HTMLImageElement | null;
    return !!i && i.complete && i.naturalHeight > 0;
  });
  await page.waitForTimeout(1500);
  await expect.poll(gap, { timeout: 4000 }).toBeLessThan(2);
});
