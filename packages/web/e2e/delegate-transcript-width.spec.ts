import { test, expect } from '@playwright/test';

// Todoist: expanding the "Using patch agent" row rendered the child's prompt as
// a bubble about one character wide. Each `.msg` pads inward by the chat
// column's gutter slack, which squeezed the narrower transcript box.
test('the delegate transcript bubble is as wide as its text needs, not a sliver', async ({
  page,
}) => {
  await page.route('**/api/chats/chat_delegate/delegates/sub-1/history*', (route) =>
    route.fulfill({
      json: {
        events: [
          {
            type: 'chat.message',
            chatId: 'sub-1',
            seq: 1,
            role: 'user',
            content:
              'Continue an interrupted job: ' +
              'finish the thing that was started earlier. '.repeat(12),
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/app/dev-harness.html?chat=chat_delegate');
  await page.locator('[data-testid="delegate-open-transcript"]').click();
  const bubble = page.locator('[data-testid="delegate-transcript-msg"] .content');
  await expect(bubble).toBeVisible();
  const box = await bubble.boundingBox();
  const stream = await page.locator('[data-testid="delegate-transcript-stream"]').boundingBox();
  expect(box!.width).toBeGreaterThan(stream!.width * 0.8);
});
