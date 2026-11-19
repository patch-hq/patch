import { test, expect } from '@playwright/test';

// Real-browser e2e for how older records still read: a chat switched in place
// before linked chats kept its provider-switch divider (one quiet line) and the
// row that opens a linked fresh chat. A failed switch no longer offers
// recoveries: a provider switch is a new linked chat (spec/04 § Provider switches).
const URL = '/app/dev-harness.html?chat=chat_handoff';

test.describe('model handoff', () => {
  test('the divider is one quiet line carrying carried-vs-total counts', async ({ page }) => {
    await page.goto(URL);
    const divider = page.getByTestId('handoff-divider');
    await expect(divider).toBeVisible();
    await expect(divider).toContainText('carried 120 of 4,100 entries');
    await expect(divider).toContainText('older history readable on demand');
    const proseSize = await page
      .locator('.msg-user .content')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const size = await divider.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeLessThan(proseSize);
    const bg = await divider.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgba(0, 0, 0, 0)');
  });

  test('a failed switch in an older record offers no in-chat recoveries', async ({ page }) => {
    await page.goto(URL);
    await expect(page.getByTestId('handoff-divider')).toBeVisible();
    await expect(page.getByTestId('handoff-retry')).toHaveCount(0);
    await expect(page.getByTestId('handoff-switch-back')).toHaveCount(0);
  });

  test('the linked-chat row opens the new chat', async ({ page }) => {
    await page.goto(URL);
    const link = page.getByTestId('handoff-link').getByRole('link');
    await expect(link).toHaveText('Continued in a linked fresh chat');
    await expect(link).toHaveAttribute('href', /\/chats\/chat_md$/);
  });
});
