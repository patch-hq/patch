import { test, expect, type Page } from '@playwright/test';
import { stubSettingsApi } from './settingsHarness.js';

// A first chat with no AI connected (design/setup-wizard): nothing asks for
// meeting permissions, the composer says why it can't send, every "Sign in"
// goes straight to signing in, and the model reads by its short name.

const SHOTS = process.env['PATCH_WELCOME_SHOTS'];
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The desktop shell on a Mac where no meeting permission is granted yet. */
async function macShellWithNothingAllowed(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { patch: object }).patch = {
      getMeetingPermissions: async () => ({
        microphone: 'unknown',
        callAudio: 'unknown',
        accessibility: 'missing',
      }),
      requestMeetingPermission: async () => 'granted',
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  // No catalogue without a sign-in: the host refuses.
  await page.route('**/api/models*', (r) =>
    r.fulfill({ status: 502, json: { error: 'upstream' } }),
  );
  await macShellWithNothingAllowed(page);
  await stubSettingsApi(page);
});

test('new chat: no meetings popover, the composer says why and links to signing in', async ({
  page,
}) => {
  await page.goto('/app/dev-harness.html?chat=new');
  await expect(page.getByTestId('composer-input')).toBeVisible();
  const notice = page.getByTestId('composer-signed-out');
  await expect(notice).toHaveText(/Sign in to Claude to send messages\./);
  // Long enough for the old once-ever introduction to have opened.
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('meeting-setup')).toHaveCount(0);
  // The default model reads as setup named it, not as an id.
  await expect(page.getByTestId('model-quick-claude-opus-5')).toHaveCount(0);
  await expect(page.getByTestId('new-chat-model')).not.toContainText('claude-opus-5');
  await shot(page, '8-new-chat-signed-out');

  await notice.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByTestId('connect')).toBeVisible();
  await expect(page.getByTestId('claude-signin-start')).toBeVisible();
  await page.getByTestId('connect-close').click();
  await expect(page.getByTestId('composer-signed-out')).toBeVisible();

  await page
    .getByTestId('claude-disconnected-banner')
    .getByRole('link', { name: 'Sign in' })
    .click();
  await expect(page.getByTestId('connect')).toBeVisible();
});

test('Meeting still asks for what it needs, when it is pressed', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_tools');
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('meeting-setup')).toHaveCount(0);
  await page.getByTestId('meeting-btn').click();
  await expect(page.getByTestId('meeting-setup')).toHaveAttribute('data-mode', 'start');
});

test('the Connect page leads with the Claude sign-in', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await page.goto('/app/dev-harness.html?route=/connect');
  const cards = page.locator('.welcome-provider');
  await expect(cards.first()).toContainText('Claude');
  await expect(cards.first().getByTestId('claude-signin-start')).toBeVisible();
  await expect(page.getByTestId('connect-close')).toHaveText('Not now');
  await shot(page, '9-connect');
});

test('the Manager with no AI: the illustration clears the banner', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=thread_manager');
  const banner = page.getByTestId('claude-disconnected-banner');
  await expect(banner).toBeVisible();
  const art = page.locator('.empty-chat-art');
  await expect(art).toBeVisible();
  await shot(page, '10-manager-signed-out');
  const [a, b] = await Promise.all([art.boundingBox(), banner.boundingBox()]);
  // Nothing of the drawing sits under the banner.
  expect(a!.y).toBeGreaterThanOrEqual(b!.y + b!.height);
});

test('Settings in a group of its own is titled Settings, not Empty group', async ({ page }) => {
  await page.goto('/app/dev-harness.html?route=/settings/usage');
  await expect(page.getByTestId('settings-usage')).toBeVisible();
  await expect(page.getByTestId('group-title')).toHaveText('Settings');
});
