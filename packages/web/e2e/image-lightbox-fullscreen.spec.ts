import { test, expect } from '@playwright/test';

// spec/14 § Composer — Attachments (patch/todo.md — "viewing the image should
// be full screen. currently its trapped in the window").
//
// jsdom can prove the overlay is portalled to <body>, but it computes no
// layout, so only a real browser can prove the consequence: the lightbox covers
// the ENTIRE window — sidebar, header and all — instead of being clipped to the
// chat panel by `.chat-main { contain: layout }`.
const IMAGE_CHAT = '/app/dev-harness.html?chat=chat_image';

// A 1x1 red PNG, served for the attachment URL so the <img> really decodes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('image lightbox', () => {
  test('covers the whole window, not just the chat panel', async ({ page }) => {
    await page.route('**/api/chats/*/attachment/*', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    await page.goto(IMAGE_CHAT);

    const chatMain = await page.locator('.chat-main').boundingBox();
    const viewport = page.viewportSize();
    if (!chatMain || !viewport) throw new Error('missing layout boxes');
    // Precondition: the chat panel is genuinely narrower than the window (the
    // sidebar is to its left), so "fills the panel" and "fills the window" are
    // distinguishable.
    expect(chatMain.x).toBeGreaterThan(0);
    expect(chatMain.width).toBeLessThan(viewport.width - 1);

    await page.getByTestId('msg-attachment-img').click();
    const lightbox = page.getByTestId('image-lightbox');
    await expect(lightbox).toBeVisible();

    const box = await lightbox.boundingBox();
    if (!box) throw new Error('lightbox has no box');
    expect(box.x).toBeLessThanOrEqual(0);
    expect(box.y).toBeLessThanOrEqual(0);
    expect(box.width).toBeGreaterThanOrEqual(viewport.width);
    expect(box.height).toBeGreaterThanOrEqual(viewport.height);

    // It is also PAINTED over the sidebar, not merely sized to the window: the
    // top-left corner of the window hit-tests into the overlay.
    const atCorner = await page.evaluate(() => {
      const el = document.elementFromPoint(8, 8);
      return el?.closest('[data-testid="image-lightbox"]') !== null;
    });
    expect(atCorner).toBe(true);

    // Esc closes it and gives the window back.
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
  });
  test('right-click opens the image menu above the viewer', async ({ page }) => {
    await page.route('**/api/chats/*/attachment/*', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    await page.goto(IMAGE_CHAT);
    await page.getByTestId('msg-attachment-img').click();
    await page
      .getByTestId('lightbox-img')
      .or(page.locator('.lightbox-img'))
      .click({ button: 'right' });
    const menu = page.getByTestId('lightbox-menu');
    await expect(menu).toBeVisible();
    // Painted above the viewer: the item hit-tests to the menu, not the overlay.
    const item = page.getByRole('menuitem', { name: 'Download image' });
    const box = await item.boundingBox();
    if (!box) throw new Error('menu item has no box');
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.closest('[role="menuitem"]') !== null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(hit).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('image-lightbox')).toBeVisible();
  });
});
