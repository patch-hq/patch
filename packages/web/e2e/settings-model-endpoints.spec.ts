import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// Real-browser e2e for Settings → Providers → Model endpoints (spec/02 §
// Provider adapters). A local model server or router is an endpoint inside
// Codex (OpenAI-compatible) or Claude Code (Anthropic-compatible): the list is
// a shared setting written to the server, its key a write-only secret.
const PROVIDERS = settingsUrl('providers');
const URL_ = 'http://127.0.0.1:11434/v1';

test.describe('Settings → Providers → Model endpoints', () => {
  test('adds an OpenAI-compatible endpoint that runs in Codex, with its key sent separately', async ({
    page,
  }) => {
    const server = await stubSettingsApi(page);
    await page.goto(PROVIDERS);
    await expect(page.getByTestId('model-endpoints-empty')).toBeVisible();
    await page.getByTestId('model-endpoint-add').click();
    await page.getByTestId('model-endpoint-new-label').fill('Ollama');
    await page.getByTestId('model-endpoint-new-url').fill(` ${URL_} `);
    await page.getByTestId('model-endpoint-new-key').fill('sk-endpoint-key-1234');
    await page.getByTestId('model-endpoint-new-save').click();
    await expect
      .poll(() => server.patches)
      .toContainEqual({
        modelEndpoints: [{ id: 'ollama', label: 'Ollama', api: 'openai', baseUrl: URL_ }],
      });
    await expect
      .poll(() => server.writes)
      .toContainEqual({
        method: 'PUT',
        path: '/api/providers/endpoints/ollama/key',
        body: { value: 'sk-endpoint-key-1234' },
      });
    // The key never rides in the settings.
    expect(JSON.stringify(server.patches)).not.toContain('sk-endpoint-key-1234');
    await expect(page.getByTestId('model-endpoint-ollama-api')).toHaveText(
      'OpenAI-compatible · runs in Codex',
    );
  });

  test('an Anthropic-compatible router runs in Claude Code, on the models named', async ({
    page,
  }) => {
    const server = await stubSettingsApi(page);
    await page.goto(PROVIDERS);
    await page.getByTestId('model-endpoint-add').click();
    await page.getByTestId('model-endpoint-new-label').fill('LiteLLM');
    await page.getByTestId('model-endpoint-new-api').selectOption('anthropic');
    await page.getByTestId('model-endpoint-new-url').fill('http://127.0.0.1:4000');
    await page.getByTestId('model-endpoint-new-models').fill('claude-x, qwen3 ');
    await page.getByTestId('model-endpoint-new-save').click();
    await expect
      .poll(() => server.patches)
      .toContainEqual({
        modelEndpoints: [
          {
            id: 'litellm',
            label: 'LiteLLM',
            api: 'anthropic',
            baseUrl: 'http://127.0.0.1:4000',
            models: ['claude-x', 'qwen3'],
          },
        ],
      });
    expect(server.writes).toEqual([]);
    await expect(page.getByTestId('model-endpoint-litellm-api')).toHaveText(
      'Anthropic-compatible · runs in Claude Code',
    );
  });

  test('says which endpoint has a key, and removes one', async ({ page }) => {
    const ollama = { id: 'ollama', label: 'Ollama', api: 'openai', baseUrl: URL_ };
    const server = await stubSettingsApi(page, {
      preferences: { modelEndpoints: [ollama] },
      secrets: { endpointKeys: [{ id: 'ollama', last4: '1234' }] },
    });
    await page.goto(PROVIDERS);
    await expect(page.getByTestId('model-endpoint-ollama-key')).toHaveText('Key set · ends 1234');
    await page.getByTestId('model-endpoint-ollama-remove').click();
    await page.getByRole('button', { name: 'Remove', exact: true }).last().click();
    await expect.poll(() => server.patches).toContainEqual({ modelEndpoints: [] });
  });
});
