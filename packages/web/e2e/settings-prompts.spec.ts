import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

test('Prompts page: switch the check-in to Custom, save, and go back to the default', async ({
  page,
}) => {
  const server = await stubSettingsApi(page);
  await page.goto(settingsUrl('prompts'));
  const shown = page.getByTestId('prompt-watch-check-in-shown');
  await expect(shown).toContainText('Background task');
  await page.getByTestId('prompt-watch-check-in-mode-custom').click();
  await page.getByTestId('prompt-watch-check-in-text').fill('Still alive?');
  await page.getByTestId('prompt-watch-check-in-save').click();
  await expect.poll(() => server.patches).toContainEqual({ watchCheckInPrompt: 'Still alive?' });
  await page.getByTestId('prompt-watch-check-in-mode-default').click();
  await expect
    .poll(() => server.patches)
    .toContainEqual({ watchCheckInPrompt: expect.stringContaining('Background task') });
  for (const id of [
    'sweep',
    'goal-judge',
    'link-summary',
    'job-autonomy',
    'question-expired',
    'tools',
    'system',
  ]) {
    await expect(page.getByTestId(`prompt-${id}`)).toBeVisible();
  }
});

test('Prompts page: the check-in interval is written in minutes', async ({ page }) => {
  const server = await stubSettingsApi(page);
  await page.goto(settingsUrl('prompts'));
  await page.getByTestId('watch-check-in-minutes').fill('15');
  await expect.poll(() => server.patches).toContainEqual({ watchCheckInMinutes: 15 });
});

test('Prompts page: the title appears once', async ({ page }) => {
  await stubSettingsApi(page);
  await page.goto(settingsUrl('prompts'));
  await expect(page.getByTestId('settings-prompts-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Prompts', exact: true })).toHaveCount(1);
});

test('Prompts page: the question-timeout text is editable and resets to the default', async ({
  page,
}) => {
  const server = await stubSettingsApi(page);
  await page.goto(settingsUrl('prompts'));
  await expect(page.getByTestId('prompt-question-expired-shown')).toContainText('Do not stop');
  await page.getByTestId('prompt-question-expired-mode-custom').click();
  await page.getByTestId('prompt-question-expired-text').fill('Keep going after {seconds}s.');
  await page.getByTestId('prompt-question-expired-save').click();
  await expect
    .poll(() => server.patches)
    .toContainEqual({ questionExpiredPrompt: 'Keep going after {seconds}s.' });
  await page.getByTestId('prompt-question-expired-mode-default').click();
  await expect
    .poll(() => server.patches)
    .toContainEqual({ questionExpiredPrompt: expect.stringContaining('Do not stop') });
});
