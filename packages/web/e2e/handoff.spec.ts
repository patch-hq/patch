import { test, expect } from '@playwright/test';

// Real-browser e2e for spec/04 § Handoff budget: the provider-switch divider is
// one quiet line, a failed handoff offers its three recoveries (each one frame
// to the host), and a linked fresh chat leaves a row that opens it.
const URL = '/app/dev-harness.html?chat=chat_handoff';

type Sent = { type: string; chatId?: string; action?: string };

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

  for (const [testId, action] of [
    ['handoff-retry', 'retry'],
    ['handoff-switch-back', 'switch_back'],
    ['handoff-linked-chat', 'linked_chat'],
  ] as const) {
    test(`${testId} sends the ${action} recovery frame`, async ({ page }) => {
      await page.goto(URL);
      await page.getByTestId(testId).click();
      const sent = await page.evaluate(() => (window as unknown as { __wsSent: Sent[] }).__wsSent);
      expect(sent).toContainEqual({
        type: 'chat.handoff_recover_request',
        chatId: 'chat_handoff',
        action,
      });
    });
  }

  test('the linked-chat row opens the new chat', async ({ page }) => {
    await page.goto(URL);
    const link = page.getByTestId('handoff-link').getByRole('link');
    await expect(link).toHaveText('Continued in a linked fresh chat');
    await expect(link).toHaveAttribute('href', /\/chats\/chat_md$/);
  });
});
