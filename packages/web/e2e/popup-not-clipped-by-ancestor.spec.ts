import { test, expect } from '@playwright/test';

// Todoist "dropdown is clipped at top" (third report). The new-chat model list
// sits inside `.chat-stream`, a scroll container, so anything of it that pokes
// above that container's top edge is clipped away — border, radius and first
// rows. The earlier fixes capped the list to the room under the chat HEADER,
// which is higher than the stream's own top edge, so on a tall window the list
// still overshot the stream.
const NEW = '/app/dev-harness.html?chat=new';

for (const [width, height] of [
  [1280, 900],
  [1280, 700],
  [390, 600],
] as const) {
  test(`model list on a ${width}x${height} window is not clipped by any ancestor`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const models = Array.from({ length: 16 }, (_, i) => ({
      id: `model-${i}`,
      label: `Model ${i}`,
    }));
    await page.route('**/api/models*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ models, fetchedAt: '2026-10-12T09:00:00.000Z' }),
      }),
    );
    await page.goto(NEW);
    await page.getByTestId('new-chat-model').click();
    const popup = page.getByTestId('model-popup');
    await expect(popup).toBeVisible();

    const clipped = await popup.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const out: string[] = [];
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflow + getComputedStyle(p).overflowY;
        if (!/(hidden|auto|scroll|clip)/.test(o)) continue;
        const pr = p.getBoundingClientRect();
        if (r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5)
          out.push(`${p.className}: popup ${r.top}-${r.bottom} vs ${pr.top}-${pr.bottom}`);
      }
      return out;
    });
    expect(clipped).toEqual([]);
  });
}
