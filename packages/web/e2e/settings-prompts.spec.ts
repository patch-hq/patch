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
  for (const id of ['sweep', 'goal-judge', 'link-summary', 'job-autonomy', 'tools', 'system']) {
    await expect(page.getByTestId(`prompt-${id}`)).toBeVisible();
  }
});

test('Prompts page: the check-in interval is written in minutes', async ({ page }) => {
  const server = await stubSettingsApi(page);
  await page.goto(settingsUrl('prompts'));
  await page.getByTestId('watch-check-in-minutes').fill('15');
  await expect.poll(() => server.patches).toContainEqual({ watchCheckInMinutes: 15 });
});
