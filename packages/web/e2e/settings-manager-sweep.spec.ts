import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// Real-browser e2e for Settings → Manager (spec/06 § The sweep): the sweep is
// off until switched on, the one switch is the Enabled row, and the controls
// that belonged to the retired stall detection are gone.
test.describe('Settings → Manager sweep', () => {
  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page, {});
    await page.goto(settingsUrl('manager'));
    await expect(page.getByTestId('settings-sweep')).toBeVisible();
  });

  test('is off by default, with one Enabled switch that turns it on', async ({ page }) => {
    const enabled = page.getByTestId('sweep-enabled');
    await expect(enabled).not.toBeChecked();
    const patch = page.waitForRequest(
      (r) => r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/settings',
    );
    await enabled.click({ force: true });
    expect((await patch).postDataJSON()).toEqual({ sweepEnabled: true });
  });

  test('the delivery slider goes from Instant to batched digests', async ({ page }) => {
    const slider = page.getByTestId('sweep-delivery');
    const patch = page.waitForRequest(
      (r) => r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/settings',
    );
    await slider.fill('0');
    await expect(page.getByTestId('sweep-delivery-label')).toHaveText('Instant');
    expect((await patch).postDataJSON()).toEqual({ sweepIntervalMinutes: 0 });
  });

  test('has the delivery slider, messages, model and standing instructions, and no stall threshold', async ({
    page,
  }) => {
    await expect(page.getByTestId('sweep-delivery-label')).toHaveText('Digest every 30 min');
    await expect(page.getByTestId('sweep-messages-per-chat')).toBeVisible();
    await expect(page.getByTestId('sweep-model')).toBeVisible();
    await expect(page.getByTestId('sweep-prompt-edit')).toBeVisible();
    await expect(page.getByTestId('sweep-stalled-threshold')).toHaveCount(0);
    await expect(page.getByText('Stalled after')).toHaveCount(0);
  });
});
