import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// Real-browser e2e for Settings → Experimental features: off by default, the
// one switch writes the account-wide setting, and Manager joins the nav only
// once it is on.
test.describe('Settings → Experimental features', () => {
  test('is off by default, with Manager out of the nav until it is switched on', async ({
    page,
  }) => {
    const server = await stubSettingsApi(page, {});
    await page.goto(settingsUrl('experimental'));
    await expect(page.getByTestId('settings-experimental')).toBeVisible();
    await expect(page.getByTestId('settings-nav-experimental')).toHaveText('Experimental features');
    await expect(page.getByTestId('settings-nav-manager')).toHaveCount(0);

    const toggle = page.getByTestId('experimental-features');
    await expect(toggle).not.toBeChecked();
    // The response, not the request: the fake server records the patch while
    // handling it, so the request event can fire before it is recorded.
    const patch = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/settings',
    );
    await toggle.click({ force: true });
    expect((await patch).request().postDataJSON()).toEqual({ experimentalFeatures: true });
    expect(server.patches).toEqual([{ experimentalFeatures: true }]);

    await expect(page.getByTestId('settings-nav-manager')).toBeVisible();
  });

  test('shows Manager in the nav when the account already has it on', async ({ page }) => {
    await stubSettingsApi(page, { preferences: { experimentalFeatures: true } });
    await page.goto(settingsUrl('experimental'));
    await expect(page.getByTestId('experimental-features')).toBeChecked();
    await expect(page.getByTestId('settings-nav-manager')).toBeVisible();
  });
});
