import { test, expect, type Page } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// Real-browser e2e for Settings → Manager (spec/14 § Special threads, spec/06 §
// Manager prompt and folder, § Finished chats, § Bounded context): the groups
// are there in the order agreed, and each control writes the account setting.

const patchOf = (page: Page) =>
  page.waitForRequest(
    (r) => r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/settings',
  );

test.describe('Settings → Manager', () => {
  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page, {});
    await page.route('**/api/manager/home', (r) =>
      r.fulfill({ contentType: 'application/json', body: JSON.stringify({ hostId: 'mac' }) }),
    );
    await page.route('**/api/chats/thread_manager', (r) =>
      r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          chatId: 'thread_manager',
          session: { messages: 34, startedAt: Date.now() },
        }),
      }),
    );
    await page.route('**/api/manager/finished', (r) =>
      r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          waiting: 2,
          sending: 0,
          lastSent: { at: new Date().setHours(14, 30, 0, 0), chats: 1 },
        }),
      }),
    );
    await page.goto(settingsUrl('manager'));
    await expect(page.getByTestId('settings-manager-context')).toBeVisible();
  });

  test('Finished chats shows what is waiting and when the last delivery went', async ({ page }) => {
    await expect(page.getByTestId('manager-finished-status').locator('.set-sub')).toHaveText(
      '2 waiting · last sent 14:30',
    );
  });

  test('has Home, Prompts, Finished chats, Context and Manager, and no sweep or instructions', async ({
    page,
  }) => {
    const order = await page
      .locator('[data-testid="settings-manager-page"] .set-group')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(order.slice(0, 5)).toEqual([
      'settings-manager-home',
      'settings-manager-prompts',
      'settings-manager-wake',
      'settings-manager-context',
      'settings-manager',
    ]);
    await expect(page.getByTestId('manager-folder')).toBeVisible();
    await expect(page.getByTestId('prompt-manager')).toBeVisible();
    // Titles only: no explainer lines under the new rows.
    await expect(page.getByTestId('prompt-manager').locator('.set-sub')).toHaveCount(0);
    await expect(page.getByTestId('manager-folder').locator('.set-sub')).toHaveCount(0);
    await expect(page.getByTestId('prompt-manager-voice')).toBeVisible();
    await expect(page.getByTestId('settings-sweep')).toHaveCount(0);
    await expect(page.getByTestId('manager-instructions')).toHaveCount(0);
    await expect(page.getByTestId('prompt-sweep')).toHaveCount(0);
  });

  test('finished chats are off by default; Batched enables Every, which writes its interval', async ({
    page,
  }) => {
    await expect(page.getByTestId('manager-wake-mode-off')).toHaveAttribute('aria-pressed', 'true');
    const slider = page.getByTestId('manager-wake-interval');
    await expect(slider).toBeDisabled();
    let patch = patchOf(page);
    await page.getByTestId('manager-wake-mode-batched').click();
    expect((await patch).postDataJSON()).toEqual({ managerWake: 'batched' });
    await expect(slider).toBeEnabled();
    await expect(page.getByTestId('manager-wake-interval-label')).toHaveText('30 min');
    patch = patchOf(page);
    await slider.fill('3');
    await expect(page.getByTestId('manager-wake-interval-label')).toHaveText('1 h');
    expect((await patch).postDataJSON()).toEqual({ managerWakeIntervalMinutes: 60 });
  });

  test('Context: the session the host reported, Clear, and the window with what it keeps', async ({
    page,
  }) => {
    await expect(page.getByTestId('manager-session')).toContainText(/34 messages · started today/);
    await expect(page.getByTestId('manager-context-window-unit')).toHaveText(
      'messages, keeping the last 40',
    );
    const rotate = page.waitForRequest((r) => r.url().endsWith('/api/chats/thread_manager/rotate'));
    await page.route('**/api/chats/thread_manager/rotate', (r) =>
      r.fulfill({ contentType: 'application/json', body: '{"ok":true}' }),
    );
    await page.getByTestId('manager-clear').click();
    expect((await rotate).postDataJSON()).toEqual({ carry: false });
  });

  test('Clear while the Manager is working shows the server’s refusal', async ({ page }) => {
    const message =
      'Cannot clear the Manager while it is working. Try again when the turn has finished.';
    await page.route('**/api/chats/thread_manager/rotate', (r) =>
      r.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: message }),
      }),
    );
    await page.getByTestId('manager-clear').click();
    await expect(page.getByTestId('error-toasts')).toContainText(message);
  });

  test('the Manager prompt saves as Custom', async ({ page }) => {
    await page.getByTestId('prompt-manager-mode-custom').click();
    await page.getByTestId('prompt-manager-text').fill('Answer in one line.');
    const patch = patchOf(page);
    await page.getByTestId('prompt-manager-save').click();
    expect((await patch).postDataJSON()).toEqual({ managerPrompt: 'Answer in one line.' });
  });

  test('the folder is saved through the server, which checks it on the home host', async ({
    page,
  }) => {
    await page.getByTestId('manager-folder-change').click();
    await page.getByTestId('manager-folder-input').fill('/srv/work');
    const patch = patchOf(page);
    await page.getByTestId('manager-folder-save').click();
    expect((await patch).postDataJSON()).toEqual({ managerFolder: '/srv/work' });
    await expect(page.getByTestId('manager-folder-path')).toHaveText('/srv/work');
  });

  test('a folder the server refuses keeps the field open and says why', async ({ page }) => {
    await page.route('**/api/settings', (r) =>
      r.request().method() === 'PATCH'
        ? r.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'manager_folder',
              message: '/srv/nope is not a folder on Studio Mac',
            }),
          })
        : r.fallback(),
    );
    await page.getByTestId('manager-folder-change').click();
    await page.getByTestId('manager-folder-input').fill('/srv/nope');
    await page.getByTestId('manager-folder-save').click();
    await expect(page.getByTestId('manager-folder-error')).toHaveText(
      '/srv/nope is not a folder on Studio Mac',
    );
    await expect(page.getByTestId('manager-folder-input')).toBeVisible();
  });
});
