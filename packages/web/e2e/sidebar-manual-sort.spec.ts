import { test, expect } from '@playwright/test';

// Manual sort: dropping a chat on a sibling moves it at once, while the pointer
// is still over the list (the list otherwise holds its order until the pointer
// leaves). Regression: the drop persisted but the rows did not move.
const HARNESS = '/app/dev-harness.html';

test('a drag-reorder moves the row immediately', async ({ page }) => {
  await page.goto(HARNESS);
  await page.getByTestId('sidebar-chat-sort-manual').click();
  const order = async (): Promise<string[]> =>
    page
      .locator('[data-testid^="chat-row-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') as string));
  const src = page.getByTestId('chat-row-chat_view_file_docx');
  await src.scrollIntoViewIfNeeded();
  const b = (await src.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 5, b.y + b.height / 2 + 5, { steps: 3 });
  const t = (await page.getByTestId('chat-row-chat_view_file').boundingBox())!;
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 10 });
  await page.mouse.move(t.x + t.width / 2 + 1, t.y + t.height / 2 + 1);
  await page.mouse.up();
  await expect
    .poll(async () => {
      const o = await order();
      return o.indexOf('chat-row-chat_view_file_docx') - o.indexOf('chat-row-chat_view_file');
    })
    .toBe(-1);
});
