import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/14 § Messages — the copy button in a message's gutter.
const HARNESS = '/app/dev-harness.html?chat=chat_bus';

test('hovering a message reveals a copy button that copies its text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(HARNESS);
  await page.evaluate(
    (e) => {
      (
        window as unknown as {
          __store: { getState: () => { applyEvent: (ev: Record<string, unknown>) => void } };
        }
      ).__store
        .getState()
        .applyEvent(e);
    },
    {
      type: 'chat.message',
      chatId: 'chat_bus',
      role: 'assistant',
      content: 'copy me please',
      seq: 2,
    } as unknown as WireEvent,
  );

  const msg = page.getByTestId('msg').last();
  const button = msg.getByTestId('msg-copy-trigger');
  await expect(button).toHaveCSS('opacity', '0');
  await msg.locator('.content').hover();
  await expect(button).toHaveCSS('opacity', '1');
  await button.click();
  await expect(button).toHaveAttribute('data-state', 'copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('copy me please');
});
