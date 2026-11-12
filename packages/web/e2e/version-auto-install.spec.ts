import { test, expect } from '@playwright/test';

// spec/11 § One update switch. One banner (UpdateBanner) offers the restart when the app
// or page is newer; Settings → Updates reports where the server and hosts stand
// under the one auto-update switch and never asks about parts one by one.
//
// The Electron shell can't be driven from Linux, so what's pinned here is the
// renderer's half — booted through the real /settings route with the one thing
// the preload hands over (`window.patch`) stubbed, same trick as
// overlay-titlebar.spec.ts.

const SETTINGS = '/app/dev-harness.html?route=/settings/updates';

const ME = {
  account: { accountId: 'acct-123', userPublicKey: 'acct-123', createdAt: 1 },
  surface: { surfaceId: 'web-1', surfaceKind: 'web', label: 'web:web-1', issuedAt: 2 },
};

const VERSION_REPORT = {
  checkedAt: '2026-09-07T12:00:00.000Z',
  server: {
    version: '0.1.900',
    gitSha: '9b8635f',
    builtAt: '2026-09-07T10:00:00.000Z',
    startedAt: '2026-09-07T11:00:00.000Z',
    serverSha: '9b8635f',
  },
  web: {
    version: '0.1.900',
    gitSha: '9b8635f',
    builtAt: '2026-09-07T10:00:00.000Z',
    bundle: 'assets/index-CtWBatg1.js',
    expectedServerSha: '9b8635f',
    deployedAt: '2026-09-07T10:05:00.000Z',
  },
  daemon: null,
  desktop: null,
  android: null,
  clients: [],
  hosts: [],
  drift: [],
};

/** The updater state the shell would push while a downloaded build installs. */
const SHELL = {
  currentVersion: '0.1.899',
  gitSha: '9b8635f',
  builtAt: '2026-09-07T09:00:00.000Z',
  feedUrl: 'https://patch.tomchambers.me/api/desktop/',
  disabledReason: null,
  lastCheckedAt: '2026-09-07T11:55:00.000Z',
  lastResult: 'downloaded',
  lastError: null,
  lastErrorKind: null,
  availableVersion: '0.1.900',
  downloaded: true,
  checking: false,
  // Behind since yesterday, so the banner is at its middle ("due") level.
  staleSince: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
};

/** Boot the harness as if it were an Electron window whose shell has an update. */
async function asDesktopShell(
  page: import('@playwright/test').Page,
  shell: Record<string, unknown>,
): Promise<void> {
  await page.addInitScript((state) => {
    (window as unknown as { __checks: number }).__checks = 0;
    (window as unknown as { __installs: number }).__installs = 0;
    (window as unknown as { patch: unknown }).patch = {
      getUpdaterState: () => Promise.resolve(state),
      checkForUpdates: () => {
        (window as unknown as { __checks: number }).__checks += 1;
        return Promise.resolve(state);
      },
      onUpdaterState: () => () => {},
      // Counted, never acted on: the point of these tests is that NOTHING
      // reaches this unless a person presses the button.
      installUpdate: () => {
        (window as unknown as { __installs: number }).__installs += 1;
      },
    };
  }, shell);
}

test.describe('version panel — updates wait to be taken', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/me', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }),
    );
    await page.route('**/api/settings', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          account: ME.account,
          devices: [],
          push: { tokenCount: 0 },
          daemon: { registered: false, status: 'offline', lastConnectedAt: null },
          projectFolders: [],
        }),
      }),
    );
    await page.route('**/api/version', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(VERSION_REPORT),
      }),
    );
  });

  test('a staged app update is offered by the banner, not by Settings', async ({ page }) => {
    await asDesktopShell(page, SHELL);
    await page.goto(SETTINGS);
    await expect(page.getByTestId('update-banner')).toBeVisible();
    // Settings speaks for the server and hosts, which are in step.
    await expect(page.getByTestId('update-status')).toHaveText('Up to date');
  });

  test('states the version, the same at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(SETTINGS);
    await expect(page.getByTestId('version-server')).toContainText('0.1.900');
  });

  test('the banner offers the restart, and only a click takes it', async ({ page }) => {
    await asDesktopShell(page, SHELL);
    await page.goto(SETTINGS);

    const banner = page.getByTestId('update-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('A new version of Patch is ready');
    // Behind since yesterday → the middle of the three levels.
    await expect(banner).toHaveAttribute('data-urgency', 'due');

    // Nothing has restarted the app just by it being here.
    expect(
      await page.evaluate(() => (window as unknown as { __installs: number }).__installs),
    ).toBe(0);

    await page.getByTestId('update-banner-restart').click();
    expect(
      await page.evaluate(() => (window as unknown as { __installs: number }).__installs),
    ).toBe(1);
  });

  test('the banner escalates by how long the shell has been behind', async ({ page }) => {
    await asDesktopShell(page, {
      ...SHELL,
      staleSince: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await page.goto(SETTINGS);
    await expect(page.getByTestId('update-banner')).toHaveAttribute('data-urgency', 'overdue');
  });

  test('a browser gets no banner — there is no shell to restart', async ({ page }) => {
    // No `window.patch` at all, which is what a real browser looks like.
    await page.goto(SETTINGS);
    await expect(page.getByTestId('update-banner')).toHaveCount(0);
  });

  test('reports status and when it last updated, without shas, and checks on demand', async ({
    page,
  }) => {
    await asDesktopShell(page, { ...SHELL, lastResult: 'up-to-date', downloaded: false });
    await page.goto(SETTINGS);

    await expect(page.getByTestId('update-status')).toHaveText('Up to date');
    await expect(page.getByTestId('version-last-updated')).not.toContainText('—');
    expect((await page.getByTestId('settings-version').textContent()) ?? '').not.toMatch(
      /[0-9a-f]{7,}/,
    );

    await page.getByTestId('version-check-now').click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __checks: number }).__checks))
      .toBeGreaterThan(0);
  });

  test('an install the shell refused is never swallowed', async ({ page }) => {
    // Squirrel.Mac refuses to apply an update to an adhoc-signed build. The
    // banner says the restart failed and what to do; the reason goes to the log.
    await asDesktopShell(page, {
      ...SHELL,
      lastResult: 'error',
      downloaded: false,
      lastErrorKind: 'install',
      lastError: 'Could not get code signature for running application',
    });
    await page.goto(SETTINGS);
    await expect(page.getByTestId('update-banner')).toContainText("Patch didn't restart.");
  });
});
