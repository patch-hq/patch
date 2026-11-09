import { test, expect, type Page, type Route } from '@playwright/test';

// Todoist "patch sending images momentarily leaves them both as attachments on
// message and uploading in chat". The sent message is echoed into the stream
// the moment Send is pressed, but the composer only released its chips once the
// hook check had returned — for that window the image showed twice. It must
// show once (in the chat), and come back to the composer if the check blocks.
const HARNESS = '/app/dev-harness.html?chat=chat_md&ws=fake';

async function attachPng(page: Page, name: string): Promise<void> {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 30;
    c.getContext('2d')!.fillRect(0, 0, 40, 30);
    return c.toDataURL('image/png');
  });
  await page.setInputFiles('[data-testid="composer-file-input"]', {
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(dataUrl.split(',')[1]!, 'base64'),
  });
}

/** One enabled message hook, with its check held until the test releases it. */
async function holdHookCheck(page: Page): Promise<Route[]> {
  const held: Route[] = [];
  await page.route('**/api/hooks', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        hooks: [{ id: 'h1', name: 'Tone', enabled: true, when: 'user_message' }],
      }),
    }),
  );
  await page.route('**/api/hooks/check', (route) => {
    held.push(route);
  });
  await page.route('**/api/chats/*/attachment', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        ref: { id: 'a1', name: 'shot.png', mimeType: 'image/png', kind: 'image', url: '/x/a1' },
      }),
    }),
  );
  return held;
}

async function sendWithImage(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.getByTestId('composer-input').fill('what is this?');
  await attachPng(page, 'shot.png');
  await expect(page.getByTestId('composer-attachment')).toHaveCount(1);
  await page.getByTestId('send-btn').click();
}

test('while the hook check runs the image is in the chat only, not also in the composer', async ({
  page,
}) => {
  const held = await holdHookCheck(page);
  await sendWithImage(page);
  await expect.poll(() => held.length).toBe(1);
  await expect(page.locator('.msg-user', { hasText: 'what is this?' })).toBeVisible();
  await expect(page.getByTestId('composer-attachment')).toHaveCount(0);

  await held[0]!.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ decision: 'pass', results: [] }),
  });
  await expect(page.getByTestId('composer-attachment')).toHaveCount(0);
});

test('a blocked send puts the image back in the composer', async ({ page }) => {
  const held = await holdHookCheck(page);
  await sendWithImage(page);
  await expect.poll(() => held.length).toBe(1);
  await expect(page.getByTestId('composer-attachment')).toHaveCount(0);

  await held[0]!.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      decision: 'block',
      results: [
        {
          hookId: 'h1',
          hookName: 'Tone',
          status: 'ok',
          decision: 'block',
          analysis: 'no',
          durationMs: 1,
        },
      ],
    }),
  });
  await expect(page.getByTestId('composer-attachment')).toHaveCount(1);
});
