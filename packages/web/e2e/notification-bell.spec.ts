import { test, expect } from '@playwright/test';

// spec/09 § bell — agent notifications behind a bell, with read state.

const HARNESS = '/app/dev-harness.html';

test.describe('notifications bell', () => {
  test('has no visible count, marks read on click and opens the source chat, mark-all clears', async ({
    page,
  }) => {
    const items = [
      {
        id: 'n2',
        chatId: 'chat_md',
        message: 'Washing done',
        importance: 'normal',
        sentAt: Date.now() - 5 * 60_000,
        readAt: null,
      },
      {
        id: 'n1',
        chatId: 'chat_bus',
        message: 'Bus in 5 min',
        importance: 'urgent',
        sentAt: Date.now() - 3_600_000,
        readAt: null,
      },
      {
        id: 'n0',
        chatId: 'chat_bus',
        message: 'Old one',
        importance: 'silent',
        sentAt: Date.now() - 86_400_000,
        readAt: 1,
      },
    ];
    const snap = () => ({ items, unread: items.filter((i) => i.readAt === null).length });
    await page.route('**/api/notifications', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snap()) }),
    );
    await page.route('**/api/notifications/read', async (r) => {
      const body = r.request().postDataJSON() as { ids?: string[]; all?: true };
      for (const i of items) {
        if (i.readAt === null && (body.all || body.ids?.includes(i.id))) i.readAt = Date.now();
      }
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snap()),
      });
    });

    await page.goto(HARNESS);
    await expect(page.getByTestId('notif-badge')).toHaveCount(0);
    await expect(page.getByTestId('notif-bell')).toHaveAttribute(
      'aria-label',
      'Notifications, 2 unread',
    );

    await page.getByTestId('notif-bell').click();
    const panel = page.getByTestId('notif-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('notif-item-n2')).toHaveAttribute('data-read', 'false');
    await expect(page.getByTestId('notif-item-n0')).toHaveAttribute('data-read', 'true');
    // newest first
    const order = await panel
      .locator('[data-testid^="notif-item-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(order).toEqual(['notif-item-n2', 'notif-item-n1', 'notif-item-n0']);

    // click one: read + opens its chat
    await page.getByTestId('notif-item-n2').click();
    await expect(page.getByTestId('chat-title')).toHaveText('July Seasonal Food');
    await expect(page.getByTestId('notif-badge')).toHaveCount(0);
    await expect(page.getByTestId('notif-bell')).toHaveAttribute(
      'aria-label',
      'Notifications, 1 unread',
    );

    // mark all read
    await page.getByTestId('notif-bell').click();
    await expect(page.getByTestId('notif-item-n2')).toHaveAttribute('data-read', 'true');
    await expect(page.getByTestId('notif-item-n1')).toHaveAttribute('data-read', 'false');
    await page.getByTestId('notif-mark-all').click();
    await expect(page.getByTestId('notif-item-n1')).toHaveAttribute('data-read', 'true');
    await expect(page.getByTestId('notif-badge')).toHaveCount(0);
    await expect(page.getByTestId('notif-mark-all')).toBeDisabled();
  });

  test('a chat with an unread notification shows a bell on its row, and opening it reads it', async ({
    page,
  }) => {
    const items = [
      {
        id: 'n1',
        chatId: 'chat_monitoring',
        message: 'Washing done',
        importance: 'normal',
        sentAt: Date.now(),
        readAt: null as number | null,
      },
    ];
    const snap = () => ({ items, unread: items.filter((i) => i.readAt === null).length });
    await page.route('**/api/notifications', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snap()) }),
    );
    await page.route('**/api/notifications/read', async (r) => {
      for (const i of items) i.readAt = Date.now();
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snap()),
      });
    });
    // spec/09 § Bell → chat row: an unread entry draws as the row's ordinary
    // unread dot, not a second glyph. `chat_monitoring` is read and quiet at
    // rest (the harness marks it read), so the dot is the entry's doing.
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_monitoring');
    await expect(row.getByTestId('badge-done')).toBeVisible();
    await expect(row.locator('[data-testid^="name-"]')).toHaveCount(0);

    // Opening the chat reads the entry, and the row settles back to its quiet
    // monitoring state.
    await row.click();
    await expect(page.getByTestId('notif-badge')).toHaveCount(0);
    await expect(row.getByTestId('badge-monitoring')).toBeVisible();
  });

  test('empty log says so and shows no badge', async ({ page }) => {
    await page.route('**/api/notifications', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], unread: 0 }),
      }),
    );
    await page.goto(HARNESS);
    await page.getByTestId('notif-bell').click();
    await expect(page.getByTestId('notif-empty')).toBeVisible();
    await expect(page.getByTestId('notif-badge')).toHaveCount(0);
  });

  // The desktop shell's top row is a window-drag region, and drag is native
  // hit-testing by geometry, not DOM ancestry: the panel is portaled to <body>
  // but opens straight under the bell, over that row, so without an explicit
  // no-drag its header ("Mark all read") starts a window drag instead of
  // clicking (the user, Patch Updates: "mark all as read doesnt work").
  test('in the desktop shell the panel is no-drag so Mark all read can be clicked', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { patch: unknown }).patch = { overlayTitleBar: true };
    });
    await page.route('**/api/notifications', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'n1',
              chatId: 'chat_bus',
              message: 'Bus in 5 min',
              importance: 'normal',
              sentAt: Date.now(),
              readAt: null,
            },
          ],
          unread: 1,
        }),
      }),
    );
    await page.goto(HARNESS);
    await page.getByTestId('notif-bell').click();
    const region = await page
      .getByTestId('notif-panel')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region').trim());
    expect(region).toBe('no-drag');
  });
});
