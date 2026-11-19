import { test, expect } from '@playwright/test';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import type { WireEvent } from '@patch/wire';

// Real-browser e2e (dev harness, real chat view + real CSS, no backend) for a
// provider switch (spec/04 § Provider switches): picking another provider's
// model drafts a new chat linked to this one (`POST /api/chats/:id/continue`)
// and opens it on the new-chat screen with its first message ready to edit.
// Nothing goes to the host. A same-provider pick is an ordinary model change.

const CATALOGUE = {
  models: [
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-opus-4-1', label: 'Opus 4.1' },
    { id: 'openai/gpt-5-codex', label: 'GPT-5 Codex' },
  ],
  fetchedAt: '2026-01-01T00:00:00.000Z',
};

const ME = {
  account: { accountId: 'acct-123', userPublicKey: 'acct-123', createdAt: 1 },
  surface: { surfaceId: 'web-1', surfaceKind: 'web', label: 'web:web-1', issuedAt: 2 },
};

/** The shared settings (spec/01 § Settings) as the server starts them. */
const BASE_PREFERENCES = { ...DEFAULT_SHARED_SETTINGS };

async function mockSettings(
  page: import('@playwright/test').Page,
): Promise<{ getPatches: () => Array<Record<string, unknown>> }> {
  let preferences = { ...BASE_PREFERENCES };
  const patches: Array<Record<string, unknown>> = [];
  await page.route('**/api/auth/me', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }),
  );
  await page.route('**/api/settings', (r) => {
    if (r.request().method() === 'PATCH') {
      const patch = r.request().postDataJSON() as Record<string, unknown>;
      patches.push(patch);
      preferences = { ...preferences, ...patch };
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ preferences }),
      });
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        account: ME.account,
        devices: [],
        push: { tokenCount: 0 },
        daemon: { registered: true, status: 'online', lastConnectedAt: 1700000000000 },
        projectFolders: [],
        preferences,
      }),
    });
  });
  return { getPatches: () => patches };
}

async function sentModelRequests(
  page: import('@playwright/test').Page,
): Promise<Array<{ chatId: string; model: string }>> {
  const sent = await page.evaluate(() => (window as unknown as { __wsSent: WireEvent[] }).__wsSent);
  return sent.filter(
    (e) => (e as { type: string }).type === 'chat.model_request',
  ) as unknown as Array<{
    chatId: string;
    model: string;
  }>;
}

test.describe('model control — a provider switch starts a linked chat', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/models*', (route) =>
      route.fulfill({ json: CATALOGUE, contentType: 'application/json' }),
    );
  });

  test('a cross-provider pick opens the drafted linked chat on the new-chat screen, sending nothing to the host', async ({
    page,
  }) => {
    await mockSettings(page);
    const continued: Array<{ url: string; body: unknown }> = [];
    await page.route('**/api/chats/*/continue', (r) => {
      continued.push({ url: r.request().url(), body: r.request().postDataJSON() });
      return r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          draft: {
            id: 'draft-linked-e2e',
            hostId: 'd1',
            folder: '/home/tom/projects/bus',
            model: 'openai/gpt-5-codex',
            text: 'This continues "Bus times". The last thing I asked: fix the departures list',
            continuedFrom: 'chat_bus',
            updatedAt: 1,
          },
        }),
      });
    });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('chat-model').click();
    await page.getByTestId('model-option-openai/gpt-5-codex').click();

    await expect(page.getByTestId('new-chat-main')).toBeVisible();
    await expect(page.getByTestId('new-chat-continues')).toBeVisible();
    await expect(page.getByTestId('composer-input')).toHaveValue(/fix the departures list/);
    expect(continued).toHaveLength(1);
    expect(continued[0]!.url).toContain('/api/chats/chat_bus/continue');
    expect(continued[0]!.body).toEqual({ model: 'openai/gpt-5-codex' });
    expect(await sentModelRequests(page)).toEqual([]);
  });

  test('a same-provider pick is an ordinary model change', async ({ page }) => {
    await mockSettings(page);
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('chat-model').click();
    await page.getByTestId('model-option-claude-opus-4-1').click();
    await expect(page.getByTestId('new-chat-main')).toHaveCount(0);
    expect(await sentModelRequests(page)).toEqual([
      expect.objectContaining({ chatId: 'chat_bus', model: 'claude-opus-4-1' }),
    ]);
  });

  test('Settings no longer has a provider-switch warning', async ({ page }) => {
    await mockSettings(page);
    await page.goto('/app/dev-harness.html?route=/settings/agent');
    await expect(page.getByTestId('provider-switch-warning')).toHaveCount(0);
  });
});
