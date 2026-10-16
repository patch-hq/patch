import { test, expect } from '@playwright/test';

// Todoist 6hmfMVVr2wwWRPxc: "patch cannot cmd z in the input box for previous
// text". ⌘Z / Ctrl+Z in the composer must step back through what was typed.
const HARNESS = '/app/dev-harness.html';

async function openChat(page: import('@playwright/test').Page) {
  await page.goto(HARNESS);
  const id = await page
    .locator('.sb-folder [data-testid^="chat-row-"]')
    .first()
    .getAttribute('data-testid');
  await page.goto(`${HARNESS}?chat=${id!.replace('chat-row-', '')}`);
  return page.getByTestId('composer-input');
}

test.describe('composer undo', () => {
  test('Ctrl+Z undoes a typed word in one step, not a character at a time', async ({ page }) => {
    const input = await openChat(page);
    await input.click();
    await page.keyboard.type('first');
    await expect(input).toHaveValue('first');
    await page.keyboard.press('Control+z');
    await expect(input).toHaveValue('');
  });
});
