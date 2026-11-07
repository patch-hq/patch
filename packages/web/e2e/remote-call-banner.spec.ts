import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real CSS, no backend) for spec/07 § A call can
// move between devices: a call live on another surface shows as a strip in flow
// above the columns, naming the device and the chat, with a Switch here button.
const REMOTE = '/app/dev-harness.html?chat=thread_manager&remoteCall=mobile';

test.describe('call in progress on another device', () => {
  test('is a strip above the columns that names the device and offers Switch here', async ({
    page,
  }) => {
    await page.goto(REMOTE);
    const banner = page.getByTestId('remote-call');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Call in progress on your phone');
    await expect(page.getByTestId('remote-call-switch')).toBeVisible();
    const box = await banner.boundingBox();
    const cols = await page.locator('.three-col').boundingBox();
    expect(box!.y).toBeLessThan(4);
    expect(cols!.y).toBeGreaterThanOrEqual(box!.y + box!.height - 1);
    expect(box!.height).toBeLessThan(60);
  });

  test('is absent when no other surface is on a call', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=thread_manager&shell');
    await expect(page.getByTestId('voice-bar')).toHaveCount(0);
    await expect(page.getByTestId('remote-call')).toHaveCount(0);
  });

  test("is replaced by this surface's own voice bar once it is on the call", async ({ page }) => {
    await page.goto(REMOTE);
    await page.evaluate(() => {
      const w = window as unknown as {
        __voiceStore: { getState(): { startCall(c: string): void } };
      };
      w.__voiceStore.getState().startCall('thread_manager');
    });
    await expect(page.getByTestId('voice-bar')).toBeVisible();
    await expect(page.getByTestId('remote-call')).toHaveCount(0);
  });
});
