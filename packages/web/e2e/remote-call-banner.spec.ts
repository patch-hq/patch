import { test, expect, type Page } from '@playwright/test';

// Real-browser e2e (dev harness, real CSS, no backend) for spec/07 § A call can
// move between devices: a call live on another surface shows as a slim strip
// under the chat header, naming the device and the chat, with a Switch here
// button. It used to run across the top of the window, where on the desktop it
// sat on the traffic lights and the header's buttons.
const REMOTE = '/app/dev-harness.html?chat=thread_manager&remoteCall=mobile';

// The traffic lights' box (packages/desktop/src/window-chrome.ts): three 12px
// lights on a 20px pitch from x=18 end at x=70; their bottom edge is y=43.
const LIGHTS = { right: 70, bottom: 43 };

async function asDesktopWindow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { patch: unknown }).patch = { overlayTitleBar: true };
  });
}

/** Does `a` overlap `b` at all? */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test.describe('call in progress on another device', () => {
  test('is a slim strip under the chat header that names the device and offers Switch here', async ({
    page,
  }) => {
    await page.goto(REMOTE);
    const banner = page.getByTestId('remote-call');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Call in progress on your phone');
    await expect(page.getByTestId('remote-call-switch')).toBeVisible();
    await expect(page.getByTestId('remote-call-end')).toBeVisible();
    const box = (await banner.boundingBox())!;
    const head = (await page.getByTestId('chat-head').first().boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
    expect(box.height).toBeLessThan(40);
    // Inside the chat pane: it starts where the header does, not at the
    // window's left edge across the sidebar.
    expect(box.x).toBeGreaterThanOrEqual(head.x - 1);
  });

  test('on the desktop it keeps clear of the traffic lights and every header button', async ({
    page,
  }) => {
    await asDesktopWindow(page);
    await page.goto(REMOTE);
    const banner = page.getByTestId('remote-call');
    await expect(banner).toBeVisible();
    const box = (await banner.boundingBox())!;
    expect(overlaps(box, { x: 0, y: 0, width: LIGHTS.right, height: LIGHTS.bottom })).toBe(false);
    const buttons = page.locator('.chat-head button:visible, .sb-brand button:visible');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const b = await buttons.nth(i).boundingBox();
      if (b) expect(overlaps(box, b)).toBe(false);
    }
    // The header still sits where it would without a call: the strip pushes
    // nothing in the window's top row down off the lights' line.
    const head = (await page.getByTestId('chat-head').first().boundingBox())!;
    await page.goto('/app/dev-harness.html?chat=thread_manager&shell');
    await expect(page.getByTestId('remote-call')).toHaveCount(0);
    const without = (await page.getByTestId('chat-head').first().boundingBox())!;
    expect(head.y).toBe(without.y);
  });

  test('is absent when no other surface is on a call', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=thread_manager&shell');
    await expect(page.getByTestId('voice-bar')).toHaveCount(0);
    await expect(page.getByTestId('remote-call')).toHaveCount(0);
  });

  test('goes when the server says no call is live', async ({ page }) => {
    await page.goto(REMOTE);
    await expect(page.getByTestId('remote-call')).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as {
        __voiceStore: { getState(): { setRemoteCalls(c: unknown[]): void } };
      };
      w.__voiceStore.getState().setRemoteCalls([]);
    });
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
