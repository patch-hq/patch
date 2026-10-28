import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real ChatHeader + real CSS, no backend) for
// spec/14 § Chat panel header: the bar is a single line. Folder · host is the
// chat title's hover tooltip, and the usage bar is not drawn up there.

test.describe('chat header title hover', () => {
  test('folder · host is the title tooltip, with nothing under the title', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    const title = page.getByTestId('chat-title');
    await expect(title).toBeVisible();
    await expect(title).toHaveAttribute('title', 'bus · dev-host');
    await expect(page.getByTestId('chat-host')).toHaveCount(0);
    await expect(page.getByTestId('folder-path')).toHaveCount(0);
    await expect(page.getByTestId('chat-head-crumb')).toHaveCount(0);
    await expect(page.locator('.chat-head-subline')).toHaveCount(0);
    await expect(page.locator('.chat-usage-crumb')).toHaveCount(0);
  });

  test('the header is one line: the title zone is no taller than its title row', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.getByTestId('chat-title')).toBeVisible();
    const zone = (await page.locator('.chat-head-title').boundingBox())!;
    const row = (await page.locator('.chat-head-title-row').boundingBox())!;
    expect(zone.height).toBeLessThanOrEqual(row.height + 1);
  });

  test('a chat with no known folder keeps no tooltip artefacts', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_no_folder');
    await expect(page.getByTestId('chat-title')).toBeVisible();
    await expect(page.getByTestId('chat-title')).not.toHaveAttribute('title', /^\s*·|·\s*$/);
  });

  // A group header (spec/14 § Groups) is left-aligned: badge · name start right
  // after Back / Forward, and the actions take the right-hand end.
  for (const [label, chatId] of [
    ['unknown-folder', 'chat_no_folder'],
    ['known-folder', 'chat_bus'],
  ] as const) {
    test(`the chat title leads the header, after Back / Forward, for a ${label} chat`, async ({
      page,
    }) => {
      await page.goto(`/app/dev-harness.html?chat=${chatId}`);
      await expect(page.getByTestId('chat-title')).toBeVisible();
      const nav = (await page.getByTestId('nav-history').boundingBox())!;
      const titleBox = (await page.locator('.chat-head-title').boundingBox())!;
      expect(titleBox.x - (nav.x + nav.width)).toBeLessThan(24);
    });
  }
});
