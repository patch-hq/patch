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
  // Signed out is said once on this screen: the notice, with no banner above it.
  await expect(page.getByTestId('claude-disconnected-banner')).toHaveCount(0);
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

test('a newcomer’s app: Manager says what it is, and nothing empty or unexplained is drawn', async ({
  page,
}) => {
  // A fresh install: every cold-storage section empty, and no chats yet but
  // the two special threads, Speakers never spoken to.
  await page.route('**/api/chats/counts', (r) =>
    r.fulfill({ json: { hidden: 0, archived: 0, snoozed: 0, deleted: 0, automations: 0 } }),
  );
  await page.route('**/api/manager/sweeps*', (r) => r.fulfill({ json: { runs: [] } }));
  await page.goto('/app/dev-harness.html?chat=thread_manager');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await page.evaluate(() => {
    type Store = {
      getState: () => { chats: Record<string, Record<string, unknown>> };
      setState: (s: { chats: Record<string, Record<string, unknown>> }) => void;
    };
    const store = (window as unknown as { __chatStore: Store }).__chatStore;
    const { chats } = store.getState();
    store.setState({
      chats: {
        thread_manager: chats['thread_manager']!,
        thread_speakers: { ...chats['thread_speakers']!, preview: null },
      },
    });
  });
  await expect(page.getByTestId('empty-chat-line')).toHaveText(
    'Ask about any of your chats, or have it message them for you.',
  );
  await expect(page.getByTestId('threads-strip')).toHaveCount(0);
  await expect(page.getByTestId('sweep-check-now')).toHaveCount(0);
  await expect(page.getByTestId('channels-toggle')).toHaveCount(0);
  await expect(page.getByTestId('sb-lifecycle')).toHaveCount(0);
  // The pill names the model the Manager starts on, never "Choose a model…".
  await expect(page.getByTestId('chat-model')).not.toContainText('Choose a model');
  await shot(page, '10-manager-newcomer');
});

test('Settings in a group of its own is titled Settings, not Empty group', async ({ page }) => {
  await page.goto('/app/dev-harness.html?route=/settings/usage');
  await expect(page.getByTestId('settings-usage')).toBeVisible();
  await expect(page.getByTestId('group-title')).toHaveText('Settings');
});
