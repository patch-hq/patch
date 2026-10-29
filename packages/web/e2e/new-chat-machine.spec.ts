import { test, expect } from '@playwright/test';

// Real-browser e2e for choosing where a new chat runs (spec/14 §8), against the
// dev harness with two hosts registered.
const NEW = '/app/dev-harness.html?chat=new&hosts=two';

test.describe('new chat — which host', () => {
  test('choosing a host offers its own folders and spawns there', async ({ page }) => {
    let spawnBody: Record<string, unknown> | null = null;
    await page.route('**/api/chats', async (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      spawnBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
      await r.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ chatId: 'c-mac', folder: '/Users/dev/code', status: 'pending' }),
      });
    });
    await page.goto(NEW);

    const home = page.getByTestId('host-option-d1');
    const mac = page.getByTestId('host-option-d2');
    await expect(home).toHaveAttribute('aria-checked', 'true');
    await expect(mac).toHaveText('mac');
    await expect(page.getByTestId('folder-quick-/Users/dev/code')).toHaveCount(0);

    await mac.click();
    await expect(mac).toHaveAttribute('aria-checked', 'true');
    await expect(home).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('folder-quick-/Users/dev/code').click();
    await expect(page.getByTestId('folder-quick-/Users/dev/code')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.folder-pill-label')).toHaveText('Other…');

    const composer = page.getByTestId('composer-input');
    await composer.fill('hello mac');
    await composer.press('Meta+Enter');
    await expect.poll(() => spawnBody).toMatchObject({ hostId: 'd2', folder: '/Users/dev/code' });
  });

  test('the host row sits above the project row, each with its label', async ({ page }) => {
    await page.goto(NEW);
    const machines = (await page.getByTestId('new-chat-machines').boundingBox())!;
    const pill = (await page.getByTestId('new-chat-folder-pill').boundingBox())!;
    expect(hosts.y + hosts.height).toBeLessThanOrEqual(pill.y + 1);
    await expect(
      page.getByTestId('new-chat-setup-grid').locator('.new-chat-setup-label'),
    ).toHaveText(['Host', 'Project', 'Model']);
    // Says Host, never host — and nothing hides in a tooltip.
    await expect(page.getByTestId('new-chat-host')).toHaveAttribute('aria-label', 'Host');
    await expect(page.getByTestId('host-option-d2')).not.toHaveAttribute('title', /.*/);
  });
});
