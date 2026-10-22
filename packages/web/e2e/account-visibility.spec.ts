import { test, expect, type Page } from '@playwright/test';
import { stubSettingsApi } from './settingsHarness.js';

// Which account a chat runs on (spec/10 § Backend credentials): a new chat can
// name the account its turns start on; a live chat's header names the account
// its latest turn ran on; and a turn that moved account because the last ran
// out of credit says so in the transcript, with when it comes back in the
// reader's own time.

const TWO_ACCOUNTS = {
  claude: [
    { id: 'a1', label: 'work', connected: true },
    { id: 'a2', label: 'personal', connected: true },
  ],
};

type Store = { getState(): { applyEvent(e: Record<string, unknown>): void } };
async function applyEvent(page: Page, event: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    (e) => (window as unknown as { __store: Store }).__store.getState().applyEvent(e),
    event,
  );
}

test('a new chat names the account it starts on, and sends it with the spawn', async ({ page }) => {
  await stubSettingsApi(page, { secrets: TWO_ACCOUNTS });
  let spawn: Record<string, unknown> | null = null;
  await page.route('**/api/chats', async (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    spawn = r.request().postDataJSON() as Record<string, unknown>;
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ chatId: 'chat-new-1', folder: spawn['folder'], status: 'pending' }),
    });
  });
  await page.goto('/app/dev-harness.html?chat=new');
  // The harness has not loaded the shared settings on its own; do what the
  // greeting would.
  await page.evaluate(async () => {
    const res = await fetch('/api/settings/shared');
    const state = await res.json();
    (
      window as unknown as { __preferencesStore: { getState(): { apply(s: unknown): void } } }
    ).__preferencesStore
      .getState()
      .apply(state);
  });
  const row = page.getByTestId('new-chat-account');
  await expect(row).toBeVisible();
  // Account is taken after the model: its row sits below the Model row.
  const rowY = (await row.boundingBox())!.y;
  const modelY = (await page.locator('.new-chat-setup-label', { hasText: 'Model' }).boundingBox())!
    .y;
  expect(rowY).toBeGreaterThan(modelY);
  // Chips, like every other row of the setup — not a native select.
  await expect(row.locator('select')).toHaveCount(0);
  await expect(row.getByRole('radio')).toHaveText(['Auto', 'work', 'personal']);
  await expect(page.getByTestId('new-chat-account-auto')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('new-chat-account-a2').click();
  await expect(page.getByTestId('new-chat-account-a2')).toHaveAttribute('aria-checked', 'true');
  await page.locator('textarea').first().fill('hello');
  await page.locator('textarea').first().press('Enter');
  await expect.poll(() => spawn).toMatchObject({ preferredAccountId: 'a2' });
});

test('a live chat’s header names the account its latest turn ran on', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_bus');
  await expect(page.getByTestId('chat-account')).toHaveCount(0);
  await applyEvent(page, {
    type: 'chat.state',
    chatId: 'chat_bus',
    activity: 'running',
    lastUpdated: Date.now(),
    permissionMode: 'auto',
    account: { id: 'a2', label: 'personal' },
  });
  await expect(page.getByTestId('chat-account')).toHaveText('personal');
});

test('a live chat with two accounts gets an account dropdown styled like the approval mode', async ({
  page,
}) => {
  await stubSettingsApi(page, { secrets: TWO_ACCOUNTS });
  await page.goto('/app/dev-harness.html?chat=chat_bus');
  await page.evaluate(async () => {
    const res = await fetch('/api/settings/shared');
    const state = await res.json();
    (
      window as unknown as { __preferencesStore: { getState(): { apply(s: unknown): void } } }
    ).__preferencesStore
      .getState()
      .apply(state);
  });
  await applyEvent(page, {
    type: 'chat.state',
    chatId: 'chat_bus',
    activity: 'idle',
    lastUpdated: Date.now(),
    permissionMode: 'auto',
    account: { id: 'a1', label: 'work' },
    preferredAccountId: null,
  });
  const select = page.getByTestId('chat-account');
  await expect(select).toHaveJSProperty('tagName', 'SELECT');
  await expect(select.locator('option')).toHaveText(['Automatic: work', 'work', 'personal']);
  // A tooltip would sit over the open list, so the select carries none.
  await expect(select).not.toHaveAttribute('title', /.*/);
  // Drawn as the approval-mode select beside it, not as a bordered chip.
  const mode = page.getByTestId('permission-mode');
  for (const prop of ['appearance', 'font-size', 'border-top-width', 'height', 'color']) {
    expect(await select.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop)).toBe(
      await mode.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop),
    );
  }

  // Choosing sends the request, reads as pending, and settles on the host's answer.
  await select.selectOption('a2');
  const sent = await page.evaluate(
    () => (window as unknown as { __wsSent: Record<string, unknown>[] }).__wsSent,
  );
  expect(sent.filter((e) => e['type'] === 'chat.account_request')).toEqual([
    { type: 'chat.account_request', chatId: 'chat_bus', preferredAccountId: 'a2' },
  ]);
  await expect(select).toHaveClass(/is-pending/);
  await applyEvent(page, {
    type: 'chat.state',
    chatId: 'chat_bus',
    activity: 'idle',
    lastUpdated: Date.now(),
    permissionMode: 'auto',
    preferredAccountId: 'a2',
  });
  await expect(select).not.toHaveClass(/is-pending/);
  await expect(select).toHaveValue('a2');

  // Back to the strategy.
  await select.selectOption('');
  const again = await page.evaluate(
    () => (window as unknown as { __wsSent: Record<string, unknown>[] }).__wsSent,
  );
  expect(again.at(-1)).toEqual({
    type: 'chat.account_request',
    chatId: 'chat_bus',
    preferredAccountId: null,
  });
});

test('a turn that moved account because the last ran out says so, in local time', async ({
  page,
}) => {
  await page.goto('/app/dev-harness.html?chat=chat_bus');
  const until = new Date('2026-09-29T20:00:00Z').getTime();
  await applyEvent(page, {
    type: 'chat.message',
    chatId: 'chat_bus',
    role: 'system',
    content: 'Switched from work to personal — work is out of credit',
    seq: 9001,
    accountSwitch: { from: 'work', to: 'personal', until },
  });
  const line = page.getByText(/Switched from work to personal — work is out until/);
  await expect(line).toBeVisible();
  // Rendered from the instant, never the raw epoch.
  await expect(line).not.toContainText(String(until));
});
