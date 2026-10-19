import { test, expect, type Page } from '@playwright/test';

// spec/14 § Keyboard shortcuts — `⌘↵` commits the field being typed in; and
// § Discoverability — a control with a shortcut names it in its tooltip.
//
// Proved in a real browser because both halves are about the browser's own
// behaviour: a chord has to reach a field that is genuinely focused (jsdom fires
// keydown at whatever element it is told to), and the chord a tooltip prints
// comes from the platform the page is actually running on. This Chromium runs on
// Linux, so the un-doctored page is the non-Mac branch taken for real.
const FORKED = '/app/dev-harness.html?chat=chat_forked&ws=fake';

/** Frames the surface has sent, as the harness records them. */
async function sent(page: Page): Promise<Array<{ type: string; [k: string]: unknown }>> {
  return page.evaluate(() => (window as unknown as { __wsSent: Array<{ type: string }> }).__wsSent);
}

/** Pretend to be a Mac keyboard, at the only layer the app is allowed to read. */
async function asMacKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: 'macOS' },
      configurable: true,
    });
  });
}

/** Carry the second user turn into the main composer and return its field. */
async function openEditor(page: Page) {
  const turn = page.locator('.msg-user').nth(1);
  // The turn box spans the whole row; only the bubble itself takes the pointer.
  await turn.getByTestId('msg-content').hover();
  await turn.getByTestId('msg-edit').click();
  const field = page.getByTestId('composer-input');
  await expect(page.getByTestId('composer-edit-banner')).toBeVisible();
  return { turn, field };
}

test.describe('editing a message in the main composer', () => {
  test('everything below the edited turn is greyed, the turn itself is not', async ({ page }) => {
    await page.goto(FORKED);
    const { turn } = await openEditor(page);
    await expect(turn).toHaveClass(/msg-edit-anchor/);
    await expect(turn).toHaveCSS('opacity', '1');
    const below = page.locator('.msg-edit-anchor ~ .msg').first();
    await expect(below).toHaveCSS('opacity', '0.35');
    const above = page.locator('.msg-user').first();
    await expect(above).toHaveCSS('opacity', '1');
    // Cancelling lifts it.
    await page.getByTestId('composer-edit-cancel').click();
    await expect(page.locator('.msg-edit-anchor')).toHaveCount(0);
  });

  test('Enter in the composer forks the turn with the new text', async ({ page }) => {
    await page.goto(FORKED);
    const { field } = await openEditor(page);
    await field.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('rewritten by keyboard');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await sent(page)).filter((e) => e.type === 'chat.fork_request').length)
      .toBe(1);
    const fork = (await sent(page)).find((e) => e.type === 'chat.fork_request')!;
    expect(fork.message).toBe('rewritten by keyboard');
    await expect(page.getByTestId('composer-edit-banner')).toHaveCount(0);
  });

  test('model and approval controls are still in the composer while editing', async ({ page }) => {
    await page.goto(FORKED);
    await openEditor(page);
    await expect(page.getByTestId('attach-btn')).toBeVisible();
  });
});

test.describe('tooltips carry their shortcut', () => {
  test('every control with a chord names it, for THIS keyboard', async ({ page }) => {
    await page.goto(FORKED);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute(
      'title',
      'Collapse sidebar (Ctrl+/)',
    );
    await expect(page.getByTestId('new-chat-fab')).toHaveAttribute('title', 'Ctrl+N');
    // New chat is the one labelled button whose shortcut is tooltip-only — no
    // inline chord tag (spec/14 § Discoverability).
    await expect(page.getByTestId('new-chat-fab-chord')).toHaveCount(0);
    await expect(page.getByTestId('archived-toggle')).toHaveAttribute(
      'title',
      'Archived (Ctrl+Shift+A)',
    );
    await expect(page.getByTestId('action-archive')).toHaveAttribute(
      'title',
      'Archive (Ctrl+Alt+A)',
    );
    await expect(page.getByTestId('send-btn')).toHaveAttribute('title', 'Send (Enter)');
  });

  test('a Mac keyboard is told about ⌘, not Ctrl', async ({ page }) => {
    await asMacKeyboard(page);
    await page.goto(FORKED);
    await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute(
      'title',
      'Collapse sidebar (⌘/)',
    );
    await expect(page.getByTestId('action-archive')).toHaveAttribute('title', 'Archive (⌘⌥A)');
    await expect(page.getByTestId('new-chat-fab')).toHaveAttribute('title', '⌘N');
    await expect(page.getByTestId('new-chat-fab-chord')).toHaveCount(0);
  });
});
