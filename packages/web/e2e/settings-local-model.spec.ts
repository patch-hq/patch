import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// Real-browser e2e for the local model endpoint in Settings → Providers
// (docs/providers.md): one OpenAI-compatible base URL, a shared setting written
// to the server, which sends it to every host. Local models then show up in
// the model picker; the endpoint is the only thing to configure.
const PROVIDERS = settingsUrl('providers');
const URL_ = 'http://127.0.0.1:11434/v1';

test.describe('Settings → Providers → Local model', () => {
  test('says the endpoint is not set, and saves one to the server', async ({ page }) => {
    const server = await stubSettingsApi(page);
    await page.goto(PROVIDERS);
    await expect(page.getByTestId('local-model-endpoint-row')).toContainText('Not set');
    await expect(page.getByTestId('local-model-endpoint-save')).toBeDisabled();
    await expect(page.getByTestId('local-model-endpoint-clear')).toHaveCount(0);

    await page.getByTestId('local-model-endpoint').fill(` ${URL_} `);
    await page.getByTestId('local-model-endpoint-save').click();
    await expect.poll(() => server.patches).toContainEqual({ localModelBaseUrl: URL_ });
    await expect(page.getByTestId('local-model-endpoint-row')).toContainText('Set');
    await expect(page.getByTestId('local-model-endpoint')).toHaveValue(URL_);
  });

  test('clearing sends an empty value', async ({ page }) => {
    const server = await stubSettingsApi(page, { preferences: { localModelBaseUrl: URL_ } });
    await page.goto(PROVIDERS);
    await expect(page.getByTestId('local-model-endpoint')).toHaveValue(URL_);
    await page.getByTestId('local-model-endpoint-clear').click();
    await expect.poll(() => server.patches).toContainEqual({ localModelBaseUrl: '' });
    await expect(page.getByTestId('local-model-endpoint-row')).toContainText('Not set');
  });

  test('Agent settings offers the local model its own permission mode, without Auto', async ({
    page,
  }) => {
    await stubSettingsApi(page);
    await page.goto(settingsUrl('agent'));
    const select = page.getByTestId('permission-default-local');
    const options = await select.locator('option').allTextContents();
    expect(options).toEqual(['Ask first', 'Allow edits', 'Never ask', 'Plan only']);
  });
});
