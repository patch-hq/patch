import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// spec/14 § Keyboard shortcuts → Customising — Settings → Shortcuts rebinds a
// chord in a real browser, and the rebinding survives a reload.

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test('rebind an action on the Shortcuts page, refuse a clash, and keep it across a reload', async ({
  page,
}) => {
  await stubSettingsApi(page);
  await page.goto(settingsUrl('shortcuts'));
  await expect(page.getByTestId('settings-shortcuts')).toBeVisible();
  await expect(page.getByTestId('shortcut-reset-toggleSidebar')).toHaveCount(0);

  await page.getByTestId('shortcut-change-toggleSidebar').click();
  await expect(page.getByTestId('shortcut-chord-toggleSidebar')).toHaveText('Press keys…');
  await page.keyboard.press(`${MOD}+Alt+KeyY`);
  await expect(page.getByTestId('shortcut-chord-toggleSidebar')).not.toHaveText('Press keys…');
  await expect(page.getByTestId('shortcut-reset-toggleSidebar')).toBeVisible();

  // A clash is refused and says whose it is.
  await page.getByTestId('shortcut-change-newChat').click();
  await page.keyboard.press(`${MOD}+KeyK`);
  await expect(page.getByTestId('shortcut-clash')).toContainText('Focus search');

  await page.reload();
  await expect(page.getByTestId('shortcut-reset-toggleSidebar')).toBeVisible();
  await page.getByTestId('shortcut-reset-toggleSidebar').click();
  await expect(page.getByTestId('shortcut-reset-toggleSidebar')).toHaveCount(0);
});
