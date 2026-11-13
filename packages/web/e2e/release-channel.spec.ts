import { test, expect } from '@playwright/test';

// Settings → Updates: stable tagged releases are the default; development builds
// are an opt-in with a warning that they are unstable.

const SETTINGS = '/app/dev-harness.html?route=/settings/updates';
const ME = {
  account: { accountId: 'acct-123', userPublicKey: 'acct-123', createdAt: 1 },
  surface: { surfaceId: 'web-1', surfaceKind: 'web', label: 'web:web-1', issuedAt: 2 },
};
const build = {
  version: '0.1.900',
  gitSha: '9b8635f',
  builtAt: '2026-09-07T10:00:00.000Z',
};
const report = (channel: string) => ({
  checkedAt: '2026-09-07T12:00:00.000Z',
  server: { ...build, startedAt: '2026-09-07T11:00:00.000Z', serverSha: '9b8635f' },
  release: { available: null, channel, autoUpdate: true, updating: false },
  web: null,
  daemon: null,
  desktop: null,
  android: null,
  clients: [],
  hosts: [],
  drift: [],
});

test.describe('release channel setting', () => {
  let channel = 'stable';
  let puts: unknown[] = [];
  test.beforeEach(async ({ page }) => {
    channel = 'stable';
    puts = [];
    const json = (body: unknown) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    await page.route('**/api/auth/me', (r) => r.fulfill(json(ME)));
    await page.route('**/api/settings', (r) =>
      r.fulfill(
        json({
          account: ME.account,
          devices: [],
          push: { tokenCount: 0 },
          daemon: { registered: false, status: 'offline', lastConnectedAt: null },
          projectFolders: [],
        }),
      ),
    );
    await page.route('**/api/version', (r) => r.fulfill(json(report(channel))));
    await page.route('**/api/release-channel', (r) => {
      const body = r.request().postDataJSON() as { channel: string };
      puts.push(body);
      channel = body.channel;
      return r.fulfill(json(body));
    });
  });

  test('stable by default, dev is opt-in and carries a warning', async ({ page }) => {
    await page.goto(SETTINGS);
    const row = page.getByTestId('release-channel');
    await expect(row).toContainText('tagged stable releases only');
    await expect(row).not.toContainText('unstable');

    await row.locator('label.toggle').click();
    await expect(row).toContainText('unstable');
    expect(puts).toEqual([{ channel: 'dev' }]);

    await row.locator('label.toggle').click();
    await expect(row).toContainText('tagged stable releases only');
    expect(puts).toEqual([{ channel: 'dev' }, { channel: 'stable' }]);
  });

  test('hidden when the operator has turned updates off', async ({ page }) => {
    channel = 'off';
    await page.goto(SETTINGS);
    await expect(page.getByTestId('version-layers')).toBeVisible();
    await expect(page.getByTestId('release-channel')).toHaveCount(0);
  });
});
