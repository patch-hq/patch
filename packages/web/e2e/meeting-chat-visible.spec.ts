import { test, expect } from '@playwright/test';

// An ended meeting's panel must never squeeze the messages out of view: however tall the panel
// has been dragged and however short the window, the chat stream keeps room to show messages.
test('a tall meeting panel on a short window still leaves the chat messages visible', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('patch.meetingPanelHeight', '0.9'));
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.goto('/app/dev-harness.html?chat=chat_tools&meeting=ended');
  await expect(page.getByTestId('meeting-panel')).toBeVisible();
  const stream = page.getByTestId('chat-stream');
  await expect
    .poll(async () => (await stream.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(120);
});
