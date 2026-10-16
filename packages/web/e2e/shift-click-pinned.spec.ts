import { test, expect } from '@playwright/test';

// Todoist: "patch cant shift click on pinned tasks to multi select". Pinned
// chats are drawn first and are part of the shift-click range (spec/14 §
// Selecting multiple rows). A real browser, because only there do the pinned
// rows' marks and the app-wide shift-click guard act on the real DOM.
const HARNESS = '/app/dev-harness.html?chat=thread_manager';

test('shift-click range-selects pinned chats, and across into the folders', async ({ page }) => {
  await page.goto(HARNESS);
  const rows = page.locator('[data-testid^="chat-row-chat_"]');
  await expect(rows.first()).toBeVisible();
  const ids = await rows.evaluateAll((els) =>
    els.slice(0, 4).map((e) => e.getAttribute('data-testid')!.replace('chat-row-', '')),
  );
  await page.evaluate((pin) => {
    const store = (
      window as unknown as { __store: { getState(): { setPinned(id: string, p: boolean): void } } }
    ).__store;
    pin.slice(0, 3).forEach((id) => store.getState().setPinned(id, true));
  }, ids);
  await expect(
    page.getByTestId('pinned-section').locator('[data-testid^="chat-row-chat_"]'),
  ).toHaveCount(3);

  const pinned = page.getByTestId('pinned-section').locator('[data-testid^="chat-row-chat_"]');
  await pinned.nth(0).click();
  await pinned.nth(2).click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('selection-count')).toHaveText(/3 selected/);
  await expect(pinned.nth(1)).toHaveAttribute('aria-selected', 'true');
});
