import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/14 § Messages — the side-thread, copy and retry buttons sit inside the
// hover strip with the time, in line, not floating in the gutters.
const CREATED_AT = new Date('2024-03-01T14:32:00Z').getTime();

for (const [label, width] of [
  ['wide', 1600],
  ['narrow', 900],
] as const) {
  test(`${label} panel: message tools share the meta strip and reveal with it`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.evaluate((createdAt) => {
      (
        window as unknown as {
          __store: { getState: () => { applyEvent: (ev: Record<string, unknown>) => void } };
        }
      ).__store
        .getState()
        .applyEvent({
          type: 'chat.message',
          chatId: 'chat_bus',
          role: 'assistant',
          content: 'tools inline answer',
          seq: 9400,
          createdAt,
        });
    }, CREATED_AT);

    const msg = page.getByTestId('msg').filter({ hasText: 'tools inline answer' });
    const meta = msg.getByTestId('msg-meta');
    await expect(meta).toHaveCSS('opacity', '0');
    await msg.hover();
    await expect(meta).toHaveCSS('opacity', '1');

    const m = await meta.boundingBox();
    if (!m) throw new Error('missing meta box');
    for (const id of ['msg-side-thread-trigger', 'msg-copy-trigger']) {
      const b = await meta.getByTestId(id).boundingBox();
      if (!b) throw new Error(`${id} is not inside the meta strip`);
      expect(b.x).toBeGreaterThanOrEqual(m.x - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(m.x + m.width + 1);
    }
    // Same row as the time in the narrow strip; stacked above it in the gutter.
    const copy = await meta.getByTestId('msg-copy-trigger').boundingBox();
    const time = await meta.getByTestId('msg-time').boundingBox();
    if (!copy || !time) throw new Error('missing boxes');
    if (width < 1100) {
      expect(Math.abs(copy.y + copy.height / 2 - (time.y + time.height / 2))).toBeLessThan(6);
    } else {
      expect(time.y).toBeGreaterThanOrEqual(copy.y + copy.height - 1);
    }
  });
}
