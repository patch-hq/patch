import { test, expect } from '@playwright/test';

// Approval mode in the composer (spec/14 § Composer — Approval mode). Todoist,
// Patch Updates: "show approval mode at the bottom under text input as a
// dropdown." It used to be a row of pills inside the Tools sidebar, two clicks
// away from the turn it governs; it is now a dropdown in the composer's action
// row, under the text input, after the utility buttons.
//
// These run in a real browser because the claim is a LAYOUT one — "under the
// text input, right of the buttons, left of send" — which jsdom cannot answer.
// The wire frames are read off the harness's fake socket (`window.__wsSent`).

declare global {
  interface Window {
    __wsSent: Array<Record<string, unknown>>;
  }
}

const HARNESS = '/app/dev-harness.html?chat=chat_md';

test.describe('Composer approval mode', () => {
  test('sits under the text input, right of the utility buttons, left of send', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    const select = page.getByTestId('permission-mode');
    await expect(select).toBeVisible();

    const selectBox = (await select.boundingBox())!;
    const inputBox = (await page.getByTestId('composer-input').boundingBox())!;
    const sendBox = (await page.getByTestId('send-btn').boundingBox())!;
    const attachBox = (await page.getByTestId('attach-btn').boundingBox())!;
    const micBox = (await page.getByTestId('voice-note-btn').boundingBox())!;

    // BELOW the text input, not beside it.
    expect(selectBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
    // Right of attach and mic — the dropdown closes the utility group.
    expect(selectBox.x).toBeGreaterThan(attachBox.x);
    expect(selectBox.x).toBeGreaterThan(micBox.x);
    // Send stays pinned to the far right, so the dropdown is still left of it.
    expect(selectBox.x).toBeLessThan(sendBox.x);
    // Inside the composer itself.
    await expect(page.getByTestId('composer').getByTestId('permission-mode')).toBeVisible();
  });

  test('offers exactly the five modes, named as the SDK names them', async ({ page }) => {
    await page.goto(HARNESS);

    const select = page.getByTestId('permission-mode');
    await expect(select).toHaveAttribute('data-value', 'auto');
    await select.click();
    // The visible text is the SAME WORDS as the value that reaches the model,
    // only cased and spaced for reading (permissionModeLabel) — no invented
    // label, and no extra row for following the host default.
    const list = page.getByTestId('permission-mode-list');
    await expect(list.getByRole('option')).toHaveText([
      'Auto',
      'Default',
      'Accept edits',
      'Bypass permissions',
      'Plan',
    ]);
    const values = await list
      .getByRole('option')
      .evaluateAll((os) => os.map((o) => (o as HTMLElement).dataset['value']));
    expect(values).toEqual(['auto', 'default', 'acceptEdits', 'bypassPermissions', 'plan']);
  });

  test('picking a mode sends chat.settings carrying it', async ({ page }) => {
    await page.goto(HARNESS);
    await page.evaluate(() => {
      window.__wsSent.length = 0;
    });

    await page.getByTestId('permission-mode').click();
    await page.locator('[data-testid="permission-mode-list"] [data-value="plan"]').click();

    await expect.poll(() => page.evaluate(() => window.__wsSent.length)).toBeGreaterThan(0);
    const sent = await page.evaluate(() => window.__wsSent);
    expect(sent.at(-1)).toEqual({
      type: 'chat.settings',
      chatId: 'chat_md',
      permissionMode: 'plan',
    });
  });

  test('every option other than the current one sends a mode — none of them sends a bare frame', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const select = page.getByTestId('permission-mode');
    const values = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

    for (const value of values) {
      await page.evaluate(() => {
        window.__wsSent.length = 0;
      });
      await select.click();
      await page.locator(`[data-testid="permission-mode-list"] [data-value="${value}"]`).click();
      await expect.poll(() => page.evaluate(() => window.__wsSent.length)).toBeGreaterThan(0);
      const sent = await page.evaluate(() => window.__wsSent);
      expect(sent.at(-1)).toEqual({
        type: 'chat.settings',
        chatId: 'chat_md',
        permissionMode: value,
      });
    }
  });

  // Todoist 6hr2VWg7J5v5wwhF: the list was a native select popup that ran off the
  // bottom of the window from the composer row. It now stays inside the viewport
  // and opens upward.
  test('the list opens upward and stays inside the window', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('permission-mode').click();
    const list = page.getByTestId('permission-mode-list');
    await expect(list).toHaveAttribute('data-direction', 'up');
    const box = (await list.boundingBox())!;
    const trigger = (await page.getByTestId('permission-mode').boundingBox())!;
    const vh = page.viewportSize()!.height;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(vh);
    expect(box.y + box.height).toBeLessThanOrEqual(trigger.y);
  });
});
