import { test, expect } from '@playwright/test';

// spec/14 ## Chat lifecycle → Manual archive: the archive chip removes the row
// at once. There is no held row and no Undo chip.
const HARNESS = '/app/dev-harness.html';

test.describe('archive from the row chip', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/chats/*/archive', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
    );
  });

  test('row leaves the folder immediately, with no undo chip', async ({ page }) => {
    await page.goto(HARNESS);

    const ids = await page
      .locator('.sb-folder [data-testid^="chat-row-"]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-testid')!.replace('chat-row-', '')),
      );
    expect(ids.length).toBeGreaterThan(0);
    const chatId = ids[0] as string;

    const row = page.locator(`.sb-folder [data-testid="chat-row-${chatId}"]`);
    await row.hover();
    await page.getByTestId(`archive-btn-${chatId}`).click();

    await expect(row).toHaveCount(0);
    await expect(page.getByTestId(`undo-archive-btn-${chatId}`)).toHaveCount(0);
    // Stays gone while the pointer rests on the sidebar (no flicker back).
    await page.waitForTimeout(500);
    await expect(row).toHaveCount(0);
  });
});
