import { test, expect } from '@playwright/test';

// Todoist: "patch message with an attachment doesnt scroll to bottom". A pin of
// ours can be overtaken by late layout (the attachment image decoding) before
// its scroll event is dispatched; the event then reports a position short of
// the grown bottom and must not be read as the reader scrolling away.

const CHAT = 'chat_scroll';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="100%" height="100%" fill="#789"/></svg>`;

const gapOf = (page: import('@playwright/test').Page) =>
  page.locator('.chat-stream').evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);

// The race is timing-dependent (about one run in two under load), so repeat it.
test('an incoming message with an image ends flush with the bottom', async ({ page }) => {
  await page.route('**/api/chats/*/attachment/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }),
  );
  for (let run = 0; run < 8; run++) {
    await page.goto(`/app/dev-harness.html?chat=${CHAT}`);
    await expect.poll(() => gapOf(page), { timeout: 4000 }).toBeLessThan(2);
    await page.evaluate(() => {
      (window as any).__store.getState().applyEvent({
        type: 'chat.message',
        chatId: 'chat_scroll',
        role: 'user',
        content: 'pic',
        seq: 99001,
        createdAt: Date.now(),
        attachments: [{ id: 'a9', name: 's.png', kind: 'image' }],
      });
    });
    await page.waitForFunction(() => {
      const i = document.querySelector('.msg-attachment-img') as HTMLImageElement | null;
      return !!i && i.complete && i.naturalHeight > 0;
    });
    await page.waitForTimeout(400);
    await expect.poll(() => gapOf(page), { timeout: 4000 }).toBeLessThan(2);
  }
});
