import { test, expect, type Page } from '@playwright/test';
import { reportHost, stubSettingsApi, wsSent } from './settingsHarness.js';

// The setup steps after the desktop app's first run (spec/05 § Desktop first
// run): connect an AI, permission mode, default model, keep running (this
// computer only) and the phone. Every choice goes through the same shared
// settings and accounts Settings uses.

const CATALOGUE = {
  models: [
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  ],
  fetchedAt: '2026-01-01T00:00:00.000Z',
};
const SHOTS = process.env['PATCH_WELCOME_SHOTS'];

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** A desktop shell that runs Patch on this computer: the keep-running bridge. */
async function localShell(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { openAtLogin: true, keepAwake: true, holdingAwake: true, canOpenAtLogin: true };
    const calls: unknown[] = [];
    (window as unknown as { __keepCalls: unknown[] }).__keepCalls = calls;
    (window as unknown as { patch: unknown }).patch = {
      overlayTitleBar: false,
      keepRunning: {
        get: async () => ({ ...state }),
        set: async (p: Partial<typeof state>) => {
          calls.push(p);
          Object.assign(state, p);
          return { ...state };
        },
      },
    };
  });
}

async function stub(page: Page, opts: Parameters<typeof stubSettingsApi>[1] = {}) {
  await page.context().route('https://claude.test/**', (r) => r.fulfill({ body: 'claude.ai' }));
  await page.route('**/api/models*', (r) => r.fulfill({ json: CATALOGUE }));
  await page.route('**/api/auth/pair/start', (r) =>
    r.fulfill({
      json: { nonce: 'n1', uri: 'patch-pair://?nonce=n1&relay=wss://relay.example&ch=c&pk=k' },
    }),
  );
  return stubSettingsApi(page, opts);
}

test('this computer: every step, each choice written where Settings writes it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await localShell(page);
  const server = await stub(page, {
    answer: (w, s) => {
      if (w.path === '/api/accounts/claude-code/signin')
        return { body: { signInId: 's1', url: 'https://claude.test/oauth/authorize?x=1' } };
      if (w.path === '/api/accounts/claude-code/signin/complete') {
        s.secrets.claude = [{ id: 'c1', label: 'Claude 1', connected: true }];
      }
    },
  });
  await page.goto('/app/dev-harness.html?route=/welcome?machine=local');

  // 1. Connect an AI — Claude in the browser, the code pasted back.
  await expect(page.getByTestId('welcome-providers')).toBeVisible();
  await expect(page.getByTestId('welcome-next')).toBeDisabled();
  // One dot per step this page asks: AI, permissions, keep running, phone —
  // and the model step joins once an AI is connected.
  await expect(page.getByTestId('welcome-dots').locator('li')).toHaveCount(4);
  await expect(page.getByTestId('welcome-dots').locator('li.done')).toHaveCount(1);
  await expect(page.getByTestId('welcome-claude-plans')).toHaveText(
    'Works with a Claude Pro, Max, Team or Enterprise plan.',
  );
  await shot(page, '2-providers');
  const opened = page.context().waitForEvent('page');
  await page.getByTestId('claude-signin-start').click();
  // claude.ai opens in the person's own browser (a new window, in the shell).
  expect((await opened).url()).toBe('https://claude.test/oauth/authorize?x=1');
  await expect(page.getByTestId('claude-signin-code')).toBeVisible();
  // The card says what to do with the page that just opened.
  await expect(page.locator('label[for="claude-signin-code"]')).toHaveText(
    'Sign in at claude.ai, copy the code it shows, and paste it here.',
  );
  await shot(page, '2b-claude-code');
  await page.getByTestId('claude-signin-code').fill('the-code#state');
  await page.getByTestId('claude-signin-finish').click();
  await expect(page.getByTestId('welcome-claude-connected')).toContainText('Claude 1');
  await expect(page.getByTestId('welcome-dots').locator('li')).toHaveCount(5);
  expect(server.writes.map((w) => [w.path, w.body])).toEqual([
    ['/api/accounts/claude-code/signin', undefined],
    ['/api/accounts/claude-code/signin/complete', { signInId: 's1', code: 'the-code#state' }],
  ]);
  await shot(page, '2c-providers-connected');
  await page.getByTestId('welcome-next').click();

  // 2. Permission mode, through the shared settings.
  await expect(page.getByTestId('welcome-permissions')).toBeVisible();
  await expect(page.getByTestId('welcome-dots').locator('li.done')).toHaveCount(2);
  const bypass = page.getByTestId('welcome-mode-bypassPermissions').locator('.welcome-option-hint');
  await expect(bypass).toHaveText('Never asks, so it can delete or overwrite anything');
  await expect(bypass).toHaveClass(/warn/);
  await shot(page, '3-permissions');
  await page.getByTestId('welcome-mode-acceptEdits').click();
  await expect.poll(() => server.patches).toContainEqual({ permissionModeDefault: 'acceptEdits' });
  await page.getByTestId('welcome-next').click();

  // 3. Default model.
  await expect(page.getByTestId('welcome-model')).toBeVisible();
  await expect(page.getByTestId('welcome-model-claude-sonnet-5')).toBeVisible();
  await shot(page, '4-model');
  await page.getByTestId('welcome-model-claude-sonnet-5').click();
  await expect.poll(() => server.patches).toContainEqual({ defaultModel: 'claude-sonnet-5' });
  await page.getByTestId('welcome-next').click();

  // 4. Keep running — on by default; turning one off reaches the shell.
  await expect(page.getByTestId('welcome-keep-running')).toBeVisible();
  await expect(page.getByTestId('welcome-open-at-login').locator('input')).toBeChecked();
  await expect(page.getByTestId('welcome-keep-awake').locator('input')).toBeChecked();
  await shot(page, '5-keep-running');
  await page.getByTestId('welcome-keep-awake').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __keepCalls: unknown[] }).__keepCalls))
    .toEqual([{ keepAwake: false }]);
  await page.getByTestId('welcome-next').click();

  // 5. The phone: first a QR that opens the app download on the phone, then,
  // on its own, the pairing QR — never both on screen to be scanned wrongly.
  await expect(page.getByTestId('welcome-phone')).toHaveAttribute('data-phase', 'app');
  await expect(page.getByTestId('welcome-apk-qr')).toHaveAttribute(
    'data-payload',
    'https://github.com/patch-hq/patch/releases/latest/download/Patch-android.apk',
  );
  await expect(page.getByTestId('welcome-qr')).toHaveCount(0);
  await expect(page.getByTestId('welcome-phone')).toContainText(
    'Scan with your phone’s camera to get the Android app.',
  );
  await expect(page.getByTestId('welcome-phone')).toContainText('iPhone isn’t available yet');
  await expect(page.getByTestId('welcome-skip')).toHaveText('No phone, skip');
  await expect(page.getByTestId('welcome-dots').locator('li.done')).toHaveCount(5);
  await shot(page, '6-phone');
  await page.getByTestId('welcome-next').click();
  await expect(page.getByTestId('welcome-phone')).toHaveAttribute('data-phase', 'pair');
  await expect(page.getByTestId('welcome-apk-qr')).toHaveCount(0);
  await expect(page.getByTestId('welcome-qr')).toHaveAttribute(
    'data-payload',
    'patch-pair://?nonce=n1&relay=wss://relay.example&ch=c&pk=k',
  );
  await expect(page.getByTestId('welcome-phone')).toContainText(
    'Open Patch on your phone and scan this code.',
  );
  await shot(page, '6c-phone-pair');
  // Back from the pairing code returns to the app download, not the step before.
  await page.getByTestId('welcome-back').click();
  await expect(page.getByTestId('welcome-phone')).toHaveAttribute('data-phase', 'app');
  await page.getByTestId('welcome-next').click();
  await page.getByTestId('welcome-next').click();
  // Setup ends on a new chat, ready to type into — not the Manager.
  await expect(page.getByTestId('welcome-finished')).toBeAttached();
});

test('nothing connected: skipping says once what it costs, the model step is not asked, and the phone can be skipped', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await stub(page);
  // With no AI signed in the host refuses the catalogue.
  await page.route('**/api/models*', (r) =>
    r.fulfill({ status: 502, json: { error: 'upstream' } }),
  );
  await page.goto('/app/dev-harness.html?route=/welcome?machine=server');
  // AI, permissions, phone: no model step with nothing to choose from.
  await expect(page.getByTestId('welcome-dots').locator('li')).toHaveCount(3);
  await expect(page.getByTestId('welcome-skip-note')).toHaveCount(0);
  await page.getByTestId('welcome-skip').click();
  // Still on the AI step: one plain line, then Continue carries on.
  await expect(page.getByTestId('welcome-providers')).toBeVisible();
  await expect(page.getByTestId('welcome-skip-note')).toHaveText(
    'Chats won’t run until you connect an AI. You can do it later from the banner in any chat.',
  );
  await expect(page.getByTestId('welcome-skip')).toHaveCount(0);
  await shot(page, '2d-skipped');
  await page.getByTestId('welcome-next').click();

  await expect(page.getByTestId('welcome-permissions')).toBeVisible();
  await expect(page.getByTestId('welcome-permissions')).not.toContainText('Claude');
  await expect(page.getByTestId('welcome-mode-auto').locator('.welcome-option-hint')).toHaveText(
    'Asks only when something looks risky',
  );
  // The mode that asks first reads as what it does, not "Default" beside a
  // preselected Auto.
  await expect(page.getByTestId('welcome-mode-default')).toContainText('Ask');
  await expect(page.getByTestId('welcome-permissions')).not.toContainText('Default');
  await page.getByTestId('welcome-next').click();

  await expect(page.getByTestId('welcome-model')).toHaveCount(0);
  await expect(page.getByTestId('welcome-phone')).toBeVisible();
  await expect(page.getByTestId('welcome-skip')).toHaveText('No phone, skip');
  await expect(page.getByTestId('welcome-apk-qr')).toHaveAttribute('width', /\d+/);
  await shot(page, '6b-phone-nothing-connected');
  await page.getByTestId('welcome-skip').click();
  await expect(page.getByTestId('welcome-finished')).toBeAttached();
});

test('ChatGPT only: the model step offers ChatGPT models and moves every chat default off Claude', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 720 });
  const server = await stub(page, {
    secrets: { codex: [{ id: 'o1', label: 'ChatGPT 1', connected: true }] },
  });
  // A host with only ChatGPT connected lists only ChatGPT's models; a Claude
  // entry here would still be held back, since it cannot run.
  await page.route('**/api/models*', (r) =>
    r.fulfill({
      json: {
        models: [
          { id: 'openai/gpt-5.2', label: 'GPT-5.2' },
          { id: 'openai/gpt-5.2-mini', label: 'GPT-5.2 mini' },
          { id: 'claude-opus-5', label: 'Opus 5' },
        ],
        fetchedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  );
  await page.goto('/app/dev-harness.html?route=/welcome?machine=server');
  await expect(page.getByTestId('welcome-dots').locator('li')).toHaveCount(4);
  await page.getByTestId('welcome-next').click();
  await page.getByTestId('welcome-next').click();

  await expect(page.getByTestId('welcome-model')).toBeVisible();
  await expect(page.getByTestId('welcome-model-openai/gpt-5.2')).toBeVisible();
  await expect(page.getByTestId('welcome-model-openai/gpt-5.2-mini')).toBeVisible();
  await expect(page.getByTestId('welcome-model-claude-opus-5')).toHaveCount(0);
  // The Claude default could not run: it is moved to the newest ChatGPT model,
  // along with the jobs' and the Manager's.
  await expect
    .poll(() => server.patches)
    .toContainEqual({
      defaultModel: 'openai/gpt-5.2',
      jobDefaultModel: 'openai/gpt-5.2',
      specialThreadModel: 'openai/gpt-5.2',
    });
  await expect(page.getByTestId('welcome-model-openai/gpt-5.2').locator('input')).toBeChecked();
  await shot(page, '4-model-chatgpt');
  await page.getByTestId('welcome-model-openai/gpt-5.2-mini').click();
  await expect.poll(() => server.patches.at(-1)).toEqual({ defaultModel: 'openai/gpt-5.2-mini' });
  await page.getByTestId('welcome-next').click();
  await expect(page.getByTestId('welcome-phone')).toBeVisible();
});

test('with an AI connected, a model list that fails says so in words, the code one click down', async ({
  page,
}) => {
  await stub(page, { secrets: { claude: [{ id: 'c1', label: 'Claude 1', connected: true }] } });
  await page.route('**/api/models*', (r) =>
    r.fulfill({ status: 502, json: { error: 'upstream' } }),
  );
  await page.goto('/app/dev-harness.html?route=/welcome?machine=server');
  await page.getByTestId('welcome-next').click();
  await page.getByTestId('welcome-next').click();
  const problem = page.getByTestId('welcome-model-problem');
  await expect(problem).toContainText('Couldn’t load the model list');
  await expect(problem.locator('p')).not.toContainText('upstream');
  await problem.getByText('Details').click();
  await expect(page.getByTestId('welcome-model-problem-detail-text')).toHaveText('upstream');
});

test('own server: no keep-running step, and the AI step can be skipped', async ({ page }) => {
  await stub(page, { secrets: { claude: [{ id: 'c1', label: 'Claude 1', connected: true }] } });
  await page.goto('/app/dev-harness.html?route=/welcome?machine=server');
  await expect(page.getByTestId('welcome-dots').locator('li')).toHaveCount(4);
  await page.getByTestId('welcome-next').click();
  await expect(page.getByTestId('welcome-permissions')).toBeVisible();
  await page.getByTestId('welcome-next').click();
  await expect(page.getByTestId('welcome-model')).toBeVisible();
  await page.getByTestId('welcome-next').click();
  await expect(page.getByTestId('welcome-phone')).toBeVisible();
  await expect(page.getByTestId('welcome-keep-running')).toHaveCount(0);
  await page.getByTestId('welcome-skip').click();
  await expect(page.getByTestId('welcome-finished')).toBeAttached();
});

test('ChatGPT sign-in runs on the online host, from the welcome step', async ({ page }) => {
  await stub(page);
  await page.goto('/app/dev-harness.html?route=/welcome?machine=server');
  await page.getByTestId('chatgpt-signin').click();
  expect((await wsSent(page)).filter((e) => e['type'] === 'host.backend_add_account')).toEqual([
    expect.objectContaining({ backendId: 'codex', authMethod: 'device' }),
  ]);
});

test('a host installing Claude Code says so, and a failed install shows why', async ({ page }) => {
  await stub(page);
  await page.goto('/app/dev-harness.html?route=/welcome?machine=local');
  const claude = { id: 'claude-code', label: 'Claude Code', version: null };
  await reportHost(page, { backends: [{ ...claude, state: 'installing' }] });
  await expect(page.getByTestId('welcome-claude-installing')).toBeVisible();
  await reportHost(page, {
    backends: [{ ...claude, state: 'failed', error: 'Installing Claude Code failed (6): curl' }],
  });
  await expect(page.getByTestId('welcome-claude-install-failed')).toContainText('curl');
  await expect(page.getByTestId('welcome-claude-installed')).toHaveCount(0);
});

test('a finished Claude Code install says so briefly instead of vanishing', async ({ page }) => {
  await stub(page);
  await page.goto('/app/dev-harness.html?route=/welcome?machine=local');
  const claude = { id: 'claude-code', label: 'Claude Code', version: null };
  await reportHost(page, { backends: [{ ...claude, state: 'installing' }] });
  await expect(page.getByTestId('welcome-claude-installing')).toBeVisible();
  await reportHost(page, { backends: [{ ...claude, state: 'present', version: '2.1.0' }] });
  await expect(page.getByTestId('welcome-claude-installing')).toHaveCount(0);
  await expect(page.getByTestId('welcome-claude-installed')).toHaveText(
    'Claude Code is installed.',
  );
  await shot(page, '2e-claude-code-installed');
  await expect(page.getByTestId('welcome-claude-installed')).toHaveCount(0, { timeout: 15_000 });
});

test('a refused Claude code says why and can be tried again', async ({ page }) => {
  await stub(page, {
    answer: (w) => {
      if (w.path === '/api/accounts/claude-code/signin')
        return { body: { signInId: 's1', url: 'https://claude.test/x' } };
      if (w.path === '/api/accounts/claude-code/signin/complete')
        return {
          status: 400,
          body: { error: 'credential_rejected', message: 'Claude refused the code (HTTP 400)' },
        };
    },
  });
  await page.goto('/app/dev-harness.html?route=/welcome?machine=server');
  await page.getByTestId('claude-signin-start').click();
  await page.getByTestId('claude-signin-code').fill('bad');
  await page.getByTestId('claude-signin-finish').click();
  await expect(page.getByTestId('claude-signin-error')).toContainText('refused the code');
  await expect(page.getByTestId('claude-signin-code')).toBeEnabled();
});
