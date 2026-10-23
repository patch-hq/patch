import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// The autonomy prompt is multi-line text: plain Enter must put a newline in it
// on every surface that edits it. Real keystrokes, because the bug was a key
// handler swallowing them.

test('Prompts page: Enter in the autonomy prompt adds a newline', async ({ page }) => {
  await stubSettingsApi(page);
  await page.goto(settingsUrl('prompts'));
  await page.getByTestId('prompt-job-autonomy-mode-custom').click();
  const box = page.getByTestId('prompt-job-autonomy-text');
  await box.fill('one');
  await box.press('End');
  await box.press('Enter');
  await box.pressSequentially('two');
  await expect(box).toHaveValue('one\ntwo');
});

test('Jobs defaults: Enter in the autonomy prompt adds a newline', async ({ page }) => {
  await stubSettingsApi(page);
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"jobs":[]}' }),
  );
  await page.goto('/app/dev-harness.html?route=/jobs');
  await page.getByTestId('job-defaults').locator('summary').click();
  await page.getByTestId('job-autonomy-prompt-default-edit').click();
  const box = page.getByTestId('job-autonomy-prompt-default');
  await box.fill('one');
  await box.press('Enter');
  await box.pressSequentially('two');
  await expect(box).toHaveValue('one\ntwo');
});

test('Job editor: Enter in the override autonomy prompt adds a newline', async ({ page }) => {
  for (const [glob, body] of [
    ['**/api/folders**', '{"hosts":[]}'],
    ['**/api/skills**', '{"skills":[],"paths":{}}'],
    ['**/api/jobs**', '{"jobs":[]}'],
  ] as const) {
    await page.route(glob, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body }),
    );
  }
  await page.goto('/app/dev-harness.html?route=/jobs/new');
  await page.getByTestId('job-advanced-toggle').click();
  await page.getByTestId('job-autonomy-prompt-custom').check({ force: true });
  const box = page.getByTestId('job-autonomy-prompt-text');
  await box.fill('one');
  await box.press('Enter');
  await box.pressSequentially('two');
  await expect(box).toHaveValue('one\ntwo');
});
