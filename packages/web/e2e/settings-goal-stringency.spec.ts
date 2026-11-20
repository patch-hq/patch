import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// Settings → Goals → Stringency: how far the goal judge trusts the agent
// (spec/04 § Goals). A shared setting written to the server.
test.describe('Settings → Goals → Stringency', () => {
  test('offers levels 1 to 3, reads 2 by default and writes the choice to the server', async ({
    page,
  }) => {
    const server = await stubSettingsApi(page);
    await page.goto(settingsUrl('goals'));
    const select = page.getByTestId('goal-stringency');
    await expect(select).toHaveValue('2');
    expect(await select.locator('option').allTextContents()).toEqual([
      "1 · Trusts the agent's last reply",
      '2 · Reads the recent chat',
      '3 · Checks every resource',
    ]);
    await page.screenshot({ path: process.env['GS_SHOT'] ?? 'test-results/goal-stringency.png' });
    await select.selectOption('3');
    await expect.poll(() => server.patches).toContainEqual({ goalStringency: 3 });
  });
});
