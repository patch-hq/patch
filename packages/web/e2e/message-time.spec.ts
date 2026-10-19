import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/14 § Messages — Message meta strip. `chat.message.createdAt` is the
// real time a turn was written (Claude Code's own transcript timestamp on
// replay, or the host's clock on a live turn) — never the store's own `at`,
// which is stamped `Date.now()` the instant a frame ARRIVES and is therefore
// "now" for every message on a replay. Hovering a message reveals the meta
// message; the real time sits on its RIGHT, level with the message's top, when
// the host sent one, and is absent entirely when it didn't (no time beats an
// invented one).
const HARNESS = '/app/dev-harness.html?chat=chat_bus';
const CHAT_ID = 'chat_bus';

function applyEvent(page: import('@playwright/test').Page, event: WireEvent) {
  return page.evaluate(
    (e) => {
      const store = (
        window as unknown as {
          __store: { getState: () => { applyEvent: (ev: Record<string, unknown>) => void } };
        }
      ).__store;
      store.getState().applyEvent(e);
    },
    event as unknown as WireEvent,
  );
}

// A fixed, known instant so the rendered clock time is asserted exactly
// rather than fuzzily matched against "whatever `now` happens to be".
const CREATED_AT = new Date('2024-03-01T14:32:00Z').getTime();

function assistantMessage(seq: number, createdAt?: number): WireEvent {
  return {
    type: 'chat.message',
    chatId: CHAT_ID,
    role: 'assistant',
    content: 'here is the answer',
    seq,
    ...(createdAt !== undefined ? { createdAt } : {}),
  } as unknown as WireEvent;
}

test.describe('hovering a message shows the real time it arrived', () => {
  test('the time shows a clock time inside the meta strip', async ({ page }) => {
    await page.goto(HARNESS);
    // "Now" is pinned to the same moment the message arrived, so this turn
    // reads as today regardless of the day this test actually runs.
    await page.clock.setFixedTime(CREATED_AT);
    await applyEvent(page, assistantMessage(2, CREATED_AT));

    const time = page.getByTestId('msg-time');
    await expect(time).toHaveCount(1);

    const expected = new Date(CREATED_AT).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    await expect(time).toHaveText(expected);

    // Part of the hover meta strip, not a bubble of its own.
    await expect(page.getByTestId('msg-meta').getByTestId('msg-time')).toHaveCount(1);
    await expect(time).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  });

  test('the meta strip names the host and model', async ({ page }) => {
    // chat_bus lives on host `dev-host` and runs `claude-sonnet-4-6`.
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.clock.setFixedTime(CREATED_AT);
    await applyEvent(page, { ...assistantMessage(9100, CREATED_AT), chatId: 'chat_bus' });

    const meta = page.getByTestId('msg-meta').last();
    const host = meta.getByTestId('msg-meta-host');
    const model = meta.getByTestId('msg-meta-model');
    await expect(host).toHaveText('dev-host');
    await expect(model).toHaveText('claude-sonnet-4-6');
    const [h, m] = await Promise.all([host.boundingBox(), model.boundingBox()]);
    expect(m!.x).toBeGreaterThan(h!.x);
  });

  test('a user message shows its time but not the host or model', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.clock.setFixedTime(CREATED_AT);
    await applyEvent(page, {
      ...assistantMessage(9101, CREATED_AT),
      chatId: 'chat_bus',
      role: 'user',
      content: 'a question from me',
    } as unknown as WireEvent);

    const bubble = page.getByTestId('msg').filter({ hasText: 'a question from me' });
    await expect(bubble.getByTestId('msg-time')).toHaveCount(1);
    await expect(bubble.getByTestId('msg-meta-host')).toHaveCount(0);
    await expect(bubble.getByTestId('msg-meta-model')).toHaveCount(0);
  });

  test('the date is prepended when the turn was not from today', async ({ page }) => {
    await page.goto(HARNESS);
    // "Now" is three days after the turn arrived, so it reads as a past day.
    const now = CREATED_AT + 3 * 86_400_000;
    await page.clock.setFixedTime(now);
    await applyEvent(page, assistantMessage(2, CREATED_AT));

    const time = page.getByTestId('msg-time');
    await expect(time).toHaveCount(1);

    const expectedTime = new Date(CREATED_AT).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    const expectedDay = new Date(CREATED_AT).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });
    await expect(time).toHaveText(`${expectedDay} ${expectedTime}`);
  });

  test('no createdAt means no time shown — never an invented one', async ({ page }) => {
    await page.goto(HARNESS);
    await applyEvent(page, assistantMessage(2));
    await expect(page.getByTestId('msg-time')).toHaveCount(0);
    // A turn that never retried and carries no known time has no strip at all.
    await expect(page.getByTestId('msg-meta')).toHaveCount(0);
  });
});
