import { test, expect } from '@playwright/test';

// Todoist: "the time always appears on the side at the top, unless the top of
// that message isn't visible, in which case it should appear at the top of the
// viewport. On hover it just comes down slightly." The time is always on the
// message's right; it is level with the message's top, or held at the top of
// the stream while that top is scrolled out.
const CHAT_ID = 'chat_bus';
const CREATED_AT = new Date('2024-03-01T14:32:00Z').getTime();

test.use({ viewport: { width: 1000, height: 600 } });

test('the time stays on the right: at the message top, then pinned to the viewport top', async ({
  page,
}) => {
  await page.goto(`/app/dev-harness.html?chat=${CHAT_ID}`);
  await page.clock.setFixedTime(CREATED_AT);
  await page.evaluate(
    ({ chatId, createdAt }) => {
      const store = (
        window as unknown as {
          __store: { getState: () => { applyEvent: (ev: Record<string, unknown>) => void } };
        }
      ).__store;
      store.getState().applyEvent({
        type: 'chat.message',
        chatId,
        role: 'assistant',
        content: Array.from({ length: 60 }, (_v, i) => `paragraph ${i}`).join('\n\n'),
        seq: 9200,
        createdAt,
      });
    },
    { chatId: CHAT_ID, createdAt: CREATED_AT },
  );

  const stream = page.locator('.chat-stream');
  const msg = page.locator('[data-testid="msg"][data-seq="9200"]');
  const pill = msg.getByTestId('msg-time');

  // Top visible: level with the message's top, on its right.
  await msg.scrollIntoViewIfNeeded();
  await stream.evaluate((el) => {
    const m = el.querySelector('[data-testid="msg"][data-seq="9200"]') as HTMLElement;
    el.scrollTop += m.getBoundingClientRect().top - el.getBoundingClientRect().top - 100;
  });
  const m1 = (await msg.boundingBox())!;
  const p1 = (await pill.boundingBox())!;
  expect(Math.abs(p1.y - m1.y)).toBeLessThanOrEqual(5);
  expect(p1.x + p1.width).toBeGreaterThan(m1.x + m1.width - 4);

  // Top scrolled out: pinned just below the top of the stream, same side.
  await stream.evaluate((el) => {
    el.scrollTop += 400;
  });
  const sbox = (await stream.boundingBox())!;
  const p2 = (await pill.boundingBox())!;
  expect(p2.y).toBeGreaterThanOrEqual(sbox.y);
  expect(p2.y).toBeLessThan(sbox.y + 40);
  expect(Math.abs(p2.x - p1.x)).toBeLessThan(1);

  // Already in its hover state without hovering; hovering changes nothing.
  await expect(pill).toHaveCSS('opacity', '1');
  await expect(pill).toHaveCSS('transform', 'none');
  await msg.hover({ position: { x: 100, y: 200 } });
  await expect(pill).toHaveCSS('opacity', '1');
  await expect(pill).toHaveCSS('transform', 'none');
  const p3 = (await pill.boundingBox())!;
  expect(Math.abs(p3.x - p1.x)).toBeLessThan(1);
});
