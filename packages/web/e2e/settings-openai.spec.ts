import { test, expect, type Page } from '@playwright/test';
import {
  reportHost,
  setHostAccount,
  settingsUrl,
  stubSettingsApi,
  wsSent,
} from './settingsHarness.js';

// Settings → Usage → ChatGPT: the shared ChatGPT accounts (spec/01 § Settings),
// their usage as a host reads it, and the ChatGPT sign-in, a device code the
// server runs and any surface shows (spec/10 § Signing in).

const stubChatGPTSignIn = async (page: Page): Promise<void> => {
  await page.route('**/api/accounts/codex/signin', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        signInId: 's1',
        userCode: 'ABCD-1234',
        url: 'https://auth.openai.com/codex/device',
        intervalSeconds: 60,
        expiresAt: Date.now() + 900_000,
      }),
    }),
  );
};

test('a ChatGPT account shows its usage', async ({ page }) => {
  await stubSettingsApi(page, {
    secrets: { codex: [{ id: 'a1', label: 'Personal ChatGPT', kind: 'chatgpt', connected: true }] },
  });
  await page.goto(settingsUrl('usage'));
  await setHostAccount(page, {
    hostId: 'd1',
    backendId: 'codex',
    connected: true,
    accounts: [
      {
        id: 'a1',
        label: 'Personal ChatGPT',
        connected: true,
        usage: { session: { status: 'allowed', utilization: 0.25 }, at: 1 },
      },
    ],
  });
  await expect(page.getByTestId('account-codex-a1')).toContainText('Personal ChatGPT');
  const session = page.getByTestId('account-usage-session-codex-a1');
  await expect(session).toContainText('5-hour');
  await expect(session).toContainText('25%');
});

test('Sign in with ChatGPT shows the code the server holds, with no host involved', async ({
  page,
}) => {
  await stubSettingsApi(page);
  await stubChatGPTSignIn(page);
  await page.goto(settingsUrl('usage'));
  await page.getByTestId('chatgpt-signin').click();
  const pending = page.getByTestId('chatgpt-login-pending');
  await expect(pending).toContainText('ABCD-1234');
  await expect(pending.getByRole('link', { name: 'Open ChatGPT again' })).toHaveAttribute(
    'href',
    'https://auth.openai.com/codex/device',
  );
  await expect(pending.getByRole('button', { name: 'Cancel' })).toBeVisible();
  expect((await wsSent(page)).filter((e) => e['type'] === 'host.backend_add_account')).toEqual([]);
});

test('API keys are added through the server and no host setup controls are shown', async ({
  page,
}) => {
  const server = await stubSettingsApi(page);
  await page.goto(settingsUrl('usage'));
  await page.getByTestId('chatgpt-add-api-key').click();
  await page.getByTestId('prompt-input').fill('sk-fake-openai-key-0000000000');
  await page.getByTestId('prompt-ok').click();
  await expect(page.getByTestId('adopt-codex-d1')).toHaveCount(0);
  await expect(page.getByTestId('chatgpt-signin-host')).toHaveCount(0);
  await expect
    .poll(() => server.writes.map((w) => [w.method, w.path, w.body]))
    .toEqual([['POST', '/api/accounts/codex', { apiKey: 'sk-fake-openai-key-0000000000' }]]);
  expect(await wsSent(page)).toEqual([]);
});

test('with no host online, ChatGPT sign-in is still available', async ({ page }) => {
  await stubSettingsApi(page);
  await page.goto(settingsUrl('usage'));
  await page.evaluate(() =>
    (
      window as unknown as {
        __presenceStore: { getState(): { setHostOnline(id: string, on: boolean): void } };
      }
    ).__presenceStore
      .getState()
      .setHostOnline('d1', false),
  );
  await expect(page.getByTestId('chatgpt-no-host')).toHaveCount(0);
  await expect(page.getByTestId('chatgpt-signin')).toBeEnabled();
});

test('a signed-out Claude host can select ChatGPT and enable the new-chat composer', async ({
  page,
}) => {
  await page.route('**/api/models*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: [{ id: 'openai/gpt-test', label: 'GPT test · ChatGPT' }] }),
    }),
  );
  await page.goto('/app/dev-harness.html?chat=new');
  await setHostAccount(page, { hostId: 'd1', backendId: 'claude-code', connected: false });
  await setHostAccount(page, {
    hostId: 'd1',
    backendId: 'codex',
    connected: true,
    accounts: [{ id: 'a1', label: 'ChatGPT', kind: 'chatgpt', connected: true }],
  });
  await page.getByTestId('new-chat-model').click();
  await page.getByRole('option', { name: 'GPT test · ChatGPT' }).click();
  await expect(page.locator('textarea').first()).toBeEnabled();
});

test('Codex sign-in on Hosts opens Usage, where the ChatGPT sign-in runs on the server', async ({
  page,
}) => {
  await stubSettingsApi(page);
  await stubChatGPTSignIn(page);
  await page.goto(settingsUrl('hosts'));
  await reportHost(page, {
    backends: [{ id: 'codex', label: 'Codex', version: '0.154.0', state: 'logged-out' }],
  });
  await page.getByTestId('host-d1-backend-codex-connect').click();
  await expect(page.getByTestId('settings-usage')).toBeVisible();
  await expect(page.getByTestId('settings-nav-usage')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText(/Paste a token from.*claude setup-token/)).toBeHidden();
  await page.getByTestId('chatgpt-signin').click();
  await expect(page.getByTestId('chatgpt-login-pending')).toContainText('ABCD-1234');
});

test('a ChatGPT sign-in that does not come back offers Trouble signing in', async ({ page }) => {
  await stubSettingsApi(page);
  await stubChatGPTSignIn(page);
  await page.goto(settingsUrl('usage'));
  await page.getByTestId('chatgpt-signin').click();
  const pending = page.getByTestId('chatgpt-login-pending');
  await expect(pending).toContainText('ABCD-1234');
  await expect(pending.getByTestId('chatgpt-add-api-key')).toHaveCount(0);
  await page.screenshot({
    path: process.env['SHOT_DIR']
      ? `${process.env['SHOT_DIR']}/chatgpt-waiting.png`
      : 'test-results/chatgpt-waiting.png',
  });
  await pending.getByTestId('chatgpt-signin-trouble').click();
  await expect(pending.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(pending.getByTestId('chatgpt-add-api-key')).toBeVisible();
  await page.screenshot({
    path: process.env['SHOT_DIR']
      ? `${process.env['SHOT_DIR']}/chatgpt-trouble.png`
      : 'test-results/chatgpt-trouble.png',
  });
});
