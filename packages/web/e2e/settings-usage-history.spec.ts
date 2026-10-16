import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// Settings → Usage: the allowance burndown for a chosen period, and chats
// ranked by tokens. The harness stubs GET /api/usage-report.

const now = Date.now();
const REPORT = {
  samples: [
    { ts: now - 3 * 3_600_000, accountId: 'a1', label: 'Work', hostId: 'd1', week: 0.2 },
    { ts: now - 2 * 3_600_000, accountId: 'a1', label: 'Work', hostId: 'd1', week: 0.35 },
    { ts: now - 1 * 3_600_000, accountId: 'a1', label: 'Work', hostId: 'd1', week: 0.6 },
  ],
  chats: [
    {
      chatId: 'c-big',
      name: 'Big refactor',
      tokens: 2_400_000,
      costUsd: 3,
      turns: 9,
      hostId: 'd1',
    },
    {
      chatId: 'c-small',
      name: 'Quick question',
      tokens: 4_000,
      costUsd: 0.1,
      turns: 1,
      hostId: 'd1',
    },
  ],
};

test.describe('settings — usage history', () => {
  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page, {});
  });

  test('draws the burndown and lists chats biggest first', async ({ page }) => {
    const urls: string[] = [];
    await page.route('**/api/usage-report**', (r) => {
      urls.push(r.request().url());
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify(REPORT) });
    });
    await page.goto(settingsUrl('usage'));
    await expect(page.getByTestId('usage-burndown')).toBeVisible();
    await expect(page.getByTestId('usage-legend')).toContainText('Work');
    const rows = page.locator('[data-testid^="usage-chat-c-"]');
    await expect(rows.first()).toContainText('Big refactor');
    await expect(page.getByTestId('usage-chat-tokens-c-big')).toHaveText('2.4M');
    expect(urls.length).toBeGreaterThan(0);
  });

  test('switching period re-queries a wider window', async ({ page }) => {
    const spans: number[] = [];
    await page.route('**/api/usage-report**', (r) => {
      const u = new URL(r.request().url());
      spans.push(Number(u.searchParams.get('until')) - Number(u.searchParams.get('since')));
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify(REPORT) });
    });
    await page.goto(settingsUrl('usage'));
    await expect(page.getByTestId('usage-burndown')).toBeVisible();
    await page.getByTestId('usage-period-day').click();
    await expect.poll(() => spans.some((s) => s === 86_400_000)).toBe(true);
    await page.getByTestId('usage-period-month').click();
    await expect.poll(() => spans.some((s) => s === 30 * 86_400_000)).toBe(true);
  });

  test('custom asks for dates, then queries that range', async ({ page }) => {
    const seen: string[] = [];
    await page.route('**/api/usage-report**', (r) => {
      seen.push(r.request().url());
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify(REPORT) });
    });
    await page.goto(settingsUrl('usage'));
    await page.getByTestId('usage-period-custom').click();
    await expect(page.getByTestId('usage-pick-range')).toBeVisible();
    const before = seen.length;
    await page.getByTestId('usage-from').fill('2026-10-01');
    await page.getByTestId('usage-to').fill('2026-10-05');
    await expect(page.getByTestId('usage-burndown')).toBeVisible();
    expect(seen.length).toBeGreaterThan(before);
  });

  test('says so when there are no readings or chats', async ({ page }) => {
    await page.goto(settingsUrl('usage'));
    await expect(page.getByTestId('usage-history-empty')).toBeVisible();
    await expect(page.getByTestId('usage-chats-empty')).toBeVisible();
  });

  test('shows the failure rather than an empty chart', async ({ page }) => {
    await page.route('**/api/usage-report**', (r) =>
      r.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'usage_unavailable', message: 'host offline' }),
      }),
    );
    await page.goto(settingsUrl('usage'));
    await expect(page.getByTestId('usage-error')).toBeVisible();
  });
});
