import { test, expect, type Page } from '@playwright/test';

// Real-browser e2e (dev harness, real ChatRoute + real CSS, no backend) for
// spec/14 § Manager view: the Manager is an ordinary chat with one extra
// header action, and finished chats reach it as collapsed notes.
const MANAGER = '/app/dev-harness.html?chat=thread_manager';
const REGULAR = '/app/dev-harness.html?chat=chat_bus';

async function emit(page: Page, event: unknown): Promise<void> {
  await page.evaluate((ev) => {
    (window as unknown as { __store: { getState(): { applyEvent(e: unknown): void } } }).__store
      .getState()
      .applyEvent(ev);
  }, event);
}

test.describe('Manager view', () => {
  test('is the conversation alone: no Threads strip', async ({ page }) => {
    await page.goto(MANAGER);
    await expect(page.getByTestId('chat-stream')).toBeVisible();
    await expect(page.getByTestId('threads-strip')).toHaveCount(0);
    await expect(page.locator('.threads-divider')).toHaveCount(0);
    // The Notify / Auto-notify reach switch is the Manager's one header control
    // besides the gear: shown here, and on no ordinary chat (below).
    await expect(page.getByTestId('reach-switch')).toBeVisible();
  });

  test('has a Manager settings gear beside Zen that opens Settings → Manager', async ({ page }) => {
    await page.goto(MANAGER);
    const gear = page.getByTestId('action-manager-settings');
    await expect(gear).toBeVisible();
    await expect(gear).toHaveAttribute('aria-label', 'Manager settings');
    // Beside Zen, in the title row.
    const zen = await page.getByTestId('action-zen').boundingBox();
    const box = await gear.boundingBox();
    expect(Math.abs(box!.y - zen!.y)).toBeLessThan(4);
    expect(box!.x).toBeGreaterThan(zen!.x);
    await gear.click();
    await expect(page.getByTestId('settings-manager-page')).toBeVisible();
  });

  test('an ordinary chat has no Manager settings gear', async ({ page }) => {
    await page.goto(REGULAR);
    await expect(page.getByTestId('action-zen')).toBeVisible();
    await expect(page.getByTestId('action-manager-settings')).toHaveCount(0);
    await expect(page.getByTestId('reach-switch')).toHaveCount(0);
  });

  test('finished chats arrive as collapsed "Finished · <name>" notes and Patch’s own line', async ({
    page,
  }) => {
    await page.goto(MANAGER);
    await expect(page.getByTestId('chat-stream')).toBeVisible();
    const base = 9000;
    for (const [i, name] of ['Bus tracker', 'Garden podcast'].entries()) {
      await emit(page, {
        type: 'chat.note',
        chatId: 'thread_manager',
        label: `Finished · ${name}`,
        text: `Chat: c${i}\nLink: patch://chats/c${i}\n\nLast reply:\nShould I carry on?`,
        seq: base + i,
        createdAt: Date.now(),
      });
    }
    await emit(page, {
      type: 'chat.message',
      chatId: 'thread_manager',
      role: 'user',
      origin: 'machine',
      content: '2 chats finished in the last 30 min.',
      seq: base + 2,
      createdAt: Date.now(),
    });
    const notes = page.getByTestId('note');
    await expect(notes.filter({ hasText: 'Finished · Bus tracker' })).toHaveCount(1);
    await expect(notes.filter({ hasText: 'Finished · Garden podcast' })).toHaveCount(1);
    const toggle = notes
      .filter({ hasText: 'Finished · Bus tracker' })
      .locator('button[aria-expanded]')
      .first();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('Should I carry on?')).toHaveCount(0);
    await toggle.click();
    await expect(page.getByText('Should I carry on?').first()).toBeVisible();
    // Not drawn as the user typing: Patch's own quiet row.
    await expect(
      page.getByTestId('job-trigger').filter({ hasText: '2 chats finished in the last 30 min.' }),
    ).toHaveCount(1);
  });

  test('the sidebar Manager row carries both Talk and the hands-free control', async ({ page }) => {
    await page.goto(MANAGER);
    await expect(page.getByTestId('row-handsfree')).toBeVisible();
    await expect(page.getByTestId('batch-tab-manager')).toHaveCount(0);
  });
});
