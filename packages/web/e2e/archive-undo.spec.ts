import { test, expect } from '@playwright/test';

// spec/14 ## Chat lifecycle → Manual archive: archive-undo hold.
// When the archive chip is clicked the chat is archived immediately, but its
// row stays rendered in-place with an Undo chip for ~4 s (or until the pointer
// leaves the sidebar). Clicking Undo reverses the archive.
const HARNESS = '/app/dev-harness.html';

test.describe('archive-undo hold', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/chats/*/archive', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
    );
  });

  test('row stays in DOM with archive-held class and undo chip after archive', async ({ page }) => {
    await page.goto(HARNESS);

    // Pick the first folder row.
    const ids = await page
      .locator('.sb-folder [data-testid^="chat-row-"]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-testid')!.replace('chat-row-', '')),
      );
    expect(ids.length).toBeGreaterThan(0);
    const chatId = ids[0] as string;

    const row = page.getByTestId(`chat-row-${chatId}`);
    const archiveBtn = page.getByTestId(`archive-btn-${chatId}`);
    const undoBtn = page.getByTestId(`undo-archive-btn-${chatId}`);

    // Hover to reveal the archive chip.
    await row.hover();
    await expect(archiveBtn).toBeVisible();

    // Click the archive chip.
    await archiveBtn.click();

    // Row must still be in the DOM with archive-held class.
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/archive-held/);

    // The archive chip is replaced by the undo chip.
    await expect(undoBtn).toBeVisible();
    await expect(archiveBtn).toHaveCount(0);
  });

  test('undo chip reverses the archive — row loses archive-held and undo chip gone', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    const ids = await page
      .locator('.sb-folder [data-testid^="chat-row-"]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-testid')!.replace('chat-row-', '')),
      );
    const chatId = ids[0] as string;

    const row = page.getByTestId(`chat-row-${chatId}`);
    await row.hover();
    await page.getByTestId(`archive-btn-${chatId}`).click();

    // Undo chip visible — click it.
    const undoBtn = page.getByTestId(`undo-archive-btn-${chatId}`);
    await expect(undoBtn).toBeVisible();
    await undoBtn.click();

    // Row must still be visible and no longer held.
    await expect(row).toBeVisible();
    await expect(row).not.toHaveClass(/archive-held/);

    // Undo chip must be gone — the row is back to its normal state.
    await expect(undoBtn).toHaveCount(0);
  });

  test('same chatId is still at those coordinates after archive — no phantom row', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    const ids = await page
      .locator('.sb-folder [data-testid^="chat-row-"]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-testid')!.replace('chat-row-', '')),
      );
    expect(ids.length).toBeGreaterThan(0);
    const chatId = ids[0] as string;

    const row = page.getByTestId(`chat-row-${chatId}`);

    // Capture the bounding box before archive.
    await row.hover();
    const boxBefore = await row.boundingBox();
    expect(boxBefore).not.toBeNull();

    await page.getByTestId(`archive-btn-${chatId}`).click();

    // Row is still at (approximately) the same place.
    await expect(row).toHaveClass(/archive-held/);
    const boxAfter = await row.boundingBox();
    expect(boxAfter).not.toBeNull();

    // The row at those coordinates must still be OUR chatId (not a different
    // chat that shuffled into the same slot after the held row left the list).
    const testIdAtCoords = await page.evaluate(
      ([x, y]: [number, number]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('[data-testid^="chat-row-"]')?.getAttribute('data-testid') ?? null;
      },
      [boxAfter!.x + boxAfter!.width / 2, boxAfter!.y + boxAfter!.height / 2] as [number, number],
    );
    expect(testIdAtCoords).toBe(`chat-row-${chatId}`);
  });

  test('moving the pointer out of the sidebar drops the held row', async ({ page }) => {
    await page.goto(HARNESS);

    const ids = await page
      .locator('.sb-folder [data-testid^="chat-row-"]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-testid')!.replace('chat-row-', '')),
      );
    const chatId = ids[0] as string;

    const row = page.getByTestId(`chat-row-${chatId}`);
    await row.hover();
    await page.getByTestId(`archive-btn-${chatId}`).click();

    // Row is held — still visible.
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/archive-held/);

    // Move the pointer out of the sidebar into the main content area.
    await page.mouse.move(800, 400);

    // Row must disappear — groupChats no longer includes it.
    await expect(row).toHaveCount(0);
  });
});
