import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// Settings → Manager → Voice tools: every tool starts on; switching one off writes the rest.
test.describe('Settings → Manager voice tools', () => {
  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page, {});
    await page.goto(settingsUrl('manager'));
    await expect(page.getByTestId('settings-manager-tools')).toBeVisible();
  });

  test('lists every tool on, and writes the list without the one switched off', async ({
    page,
  }) => {
    await expect(page.getByTestId('manager-tool-add_task-toggle')).toBeChecked();
    await page
      .getByTestId('settings-manager-tools')
      .screenshot({ path: process.env['SHOT'] ?? 'test-results/manager-tools.png' });
    const patch = page.waitForRequest(
      (r) => r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/settings',
    );
    await page.getByTestId('manager-tool-ask_agent-toggle').click({ force: true });
    expect((await patch).postDataJSON()).toEqual({
      managerVoiceTools: [
        'find_chats',
        'chat_status',
        'send_to_chat',
        'add_task',
        'calendar_agenda',
        'add_event',
      ],
    });
  });
});
