import { test, expect } from '@playwright/test';
import { stubSettingsApi } from './settingsHarness.js';

// Settings → Bug reports: automatic GitHub issue filing (off by default) and the
// Report a bug form, in a real browser.

test('bug reports: off by default, switch on, and file a manual report', async ({ page }) => {
  await stubSettingsApi(page, {});
  let enabled = false;
  let report: Record<string, unknown> | null = null;
  await page.route('**/api/issue-reporting', async (r) => {
    if (r.request().method() === 'PUT') {
      enabled = (r.request().postDataJSON() as { enabled: boolean }).enabled;
    }
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled,
        repo: 'patch-hq/patch',
        tokenConfigured: true,
        pending: 0,
        filed: 3,
        lastError: null,
      }),
    });
  });
  await page.route('**/api/issue-reports', async (r) => {
    report = r.request().postDataJSON() as Record<string, unknown>;
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, url: 'https://github.com/patch-hq/patch/issues/42' }),
    });
  });
  await page.goto('/app/dev-harness.html?route=/settings/bugs');
  const toggle = page.getByTestId('issue-reporting-toggle');
  await expect(toggle).not.toBeChecked();
  if (process.env['PATCH_SHOT']) {
    await page.screenshot({ path: `${process.env['PATCH_SHOT']}/bug-reports-off.png` });
  }
  await toggle.click({ force: true });
  await expect(toggle).toBeChecked();
  expect(enabled).toBe(true);

  await page.getByTestId('bug-open').click();
  await page.getByTestId('bug-platform').fill('');
  await page.getByTestId('bug-title').fill('Send button does nothing');
  await page.getByTestId('bug-description').fill('Tapping send on a new chat does nothing.');
  if (process.env['PATCH_SHOT']) {
    await page.screenshot({ path: `${process.env['PATCH_SHOT']}/bug-reports-form.png` });
  }
  await page.getByTestId('bug-send').click();
  await expect(page.getByTestId('bug-filed')).toContainText('issues/42');
  expect(report).toMatchObject({ title: 'Send button does nothing', surface: 'web', platform: '' });
  if (process.env['PATCH_SHOT']) {
    await page.screenshot({ path: `${process.env['PATCH_SHOT']}/bug-reports-filed.png` });
  }
});
