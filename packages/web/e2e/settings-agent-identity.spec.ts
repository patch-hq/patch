import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

test('Agent identity is a complete Cloudflare setup flow', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const server = await stubSettingsApi(page);
  await page.route('**/.well-known/http-message-signatures-directory', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/http-message-signatures-directory+json',
      body: JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'public-key' }] }),
      headers: { 'signature-input': 'sig1=("@authority";req);keyid="key-123"' },
    }),
  );

  await page.goto(settingsUrl('identity'));
  await expect(page.getByTestId('settings-identity-ready')).toContainText('Ready');
  await expect(page.getByTestId('settings-identity-key-id')).toContainText('key-123');
  await expect(page.getByTestId('settings-identity-key-generation')).toContainText('Ed25519 key');
  await expect(page.getByTestId('identity-enabled-status')).toContainText(
    'Off — browser requests are unsigned',
  );
  await page.getByTestId('identity-enabled').click({ force: true });
  await expect
    .poll(() => server.patches)
    .toContainEqual({ agentIdentity: expect.objectContaining({ enabled: true }) });
  await expect(page.getByTestId('identity-enabled-status')).toContainText(
    'On — browser requests are signed',
  );

  await page.getByTestId('identity-name').fill('My Patch agent');
  await page.getByTestId('identity-name').blur();
  await expect
    .poll(() => server.patches)
    .toContainEqual({
      agentIdentity: expect.objectContaining({ name: 'My Patch agent' }),
    });

  await page.getByTestId('identity-copy-directory').click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('/.well-known/http-message-signatures-directory');
  await expect(page.getByTestId('identity-cloudflare')).toHaveAttribute(
    'href',
    /dash\.cloudflare\.com/,
  );
  const cloudflareValues = page.getByTestId('identity-cloudflare-values');
  await expect(cloudflareValues).toContainText('web_bot_auth');
  await expect(cloudflareValues).toContainText('Signature URL');
  await expect(cloudflareValues).not.toContainText('Verification method');
  await expect(cloudflareValues).not.toContainText('Validation instructions');
  await expect(page.getByTestId('identity-cloudflare-values')).toContainText('Direct');
  await expect(page.getByTestId('identity-cloudflare-values')).not.toContainText('Use the');
  await expect(page.getByTestId('identity-cloudflare-values')).toContainText('My Patch agent');

  await page.getByTestId('identity-copy-name').click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('My Patch agent');
});

test('a local-only server explains the requirement and hides unusable setup', async ({ page }) => {
  await stubSettingsApi(page, {
    webBotAuthStatus: {
      ready: false,
      issue: 'Web Bot Auth requires a publicly accessible HTTPS server',
      origin: 'http://localhost:8787',
      agentUrl: 'http://localhost:8787/agent',
      directoryUrl: 'http://localhost:8787/.well-known/http-message-signatures-directory',
      keyId: 'key-123',
    },
  });

  await page.goto(settingsUrl('identity'));
  await expect(page.getByTestId('settings-identity-unavailable')).toContainText(
    'publicly accessible HTTPS server',
  );
  await expect(page.getByTestId('settings-identity-details')).toHaveCount(0);
  await expect(page.getByTestId('settings-identity-urls')).toHaveCount(0);
  await expect(page.getByTestId('identity-cloudflare-values')).toHaveCount(0);
  await expect(page.getByTestId('identity-enabled')).toHaveCount(0);
  await expect(page.getByTestId('identity-cloudflare')).toHaveCount(0);
});
