import { test, expect, type Page } from '@playwright/test';

// spec/12 § A usage or rate limit — what a person is shown when a turn cannot
// run yet.
//
// This is in a REAL browser rather than jsdom for the two things jsdom cannot
// judge: where the notice sits in the document (it has to be inside the
// transcript, under the last message — it used to be a strip in the chrome),
// and whether the countdown actually counts (a countdown that does not count is
// a timestamp with extra steps).
//
// The sentence it replaced was "Extra usage limit on Default, resuming at 15:40
// (in 1 h)", which named a limit nobody had reached — overage is the OVERFLOW
// that covers for the session and week, not something a person spends — gave a
// clock time instead of a wait, and used a unit symbol nobody says out loud.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

/** Park `chat_md` on a limit, exactly as a `chat.state` from the host would. */
async function park(
  page: Page,
  block: Record<string, unknown>,
  msFromNow = 63 * 60_000,
): Promise<void> {
  await page.evaluate(
    ({ block: b, ms }) => {
      const w = window as unknown as {
        __store: {
          getState: () => {
            chats: Record<string, { hostId: string; folder: string }>;
            applyEvent: (e: unknown) => void;
          };
        };
        __presenceStore: { getState: () => { setHostReport: (e: unknown) => void } };
      };
      w.__presenceStore.getState().setHostReport({
        type: 'host.host',
        hostId: 'd1',
        hostName: 'box',
        backends: [],
        components: [],
        autoResumeRateLimit: true,
      });
      const row = w.__store.getState().chats['chat_md']!;
      const at = Date.now() + ms;
      w.__store.getState().applyEvent({
        type: 'chat.state',
        chatId: 'chat_md',
        hostId: row.hostId,
        activity: 'idle',
        folder: row.folder,
        lastUpdated: Date.now(),
        permissionMode: 'bypassPermissions',
        rateLimitResumingAt: at,
        resumeKind: 'rate_limit',
        limitBlock: { resetsAt: at, ...b },
      });
    },
    { block, ms: msFromNow },
  );
}

test.describe('the limit bubble', () => {
  test('names the pool that RAN OUT, never the overflow that failed to cover it', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await park(page, {
      scope: 'session',
      accountLabel: 'Default',
      overageBlocked: true,
      overageReason: 'org_level_disabled_until',
    });

    const bubble = page.getByTestId('rate-limit-bar');
    await expect(page.getByTestId('rate-limit-headline')).toHaveText('Session limit · Default');
    // The headline that started this. It must not come back.
    await expect(bubble).not.toContainText(/extra usage limit/i);
  });

  test('sits in the transcript under the last message, not in the chrome above it', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await park(page, { scope: 'session' });

    const inStream = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="rate-limit-bar"]');
      const stream = document.querySelector('[data-testid="chat-stream"]');
      return {
        inside: !!(el && stream && stream.contains(el)),
        last: !!(el && el.parentElement && el.parentElement.lastElementChild === el),
      };
    });
    expect(inStream.inside).toBe(true);
    expect(inStream.last).toBe(true);
  });

  test('counts down in the corner without anything else changing', async ({ page }) => {
    await page.goto(HARNESS);
    // 125s reads as "2 min"; thirty seconds later it must read "1 min". Nothing
    // else touches the store in between, so only the component's own clock can
    // move it.
    await park(page, { scope: 'session' }, 125_000);

    const countdown = page.getByTestId('rate-limit-countdown');
    await expect(countdown).toContainText('Resets in 2 min');
    await expect(countdown).toContainText('Resets in 1 min', { timeout: 40_000 });
  });

  test('is full width, text is at least 14px, and the controls are always the same', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(HARNESS);
    await park(page, { scope: 'session' });
    const card = page.locator('[data-testid="rate-limit-bar"] .content');
    await expect(card).toBeVisible();
    const stream = (await page.getByTestId('chat-stream').boundingBox())!;
    const box = (await card.boundingBox())!;
    expect(box.width).toBeGreaterThan(stream.width * 0.8);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="rate-limit-bar"] *')]
        .filter(
          (el) =>
            el.childNodes.length &&
            [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()),
        )
        .map((el) => parseFloat(getComputedStyle(el).fontSize))
        .filter((px) => px < 14),
    );
    expect(small).toEqual([]);
    for (const id of [
      'rate-limit-send',
      'rate-limit-change-account',
      'rate-limit-change-provider',
      'rate-limit-extra-usage',
      'rate-limit-auto-resume',
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    // Before the reset Send waits, and says when.
    await expect(page.getByTestId('rate-limit-send')).toHaveAttribute('title', /^Available at /);
    await expect(page.getByTestId('rate-limit-change-model')).toHaveCount(0);
    await page.screenshot({ path: process.env['LIMIT_SHOT'] ?? 'test-results/limit-card.png' });
  });

  // Todoist 6hr2VWg7J5v5wwhF: the Change account / Change provider menus opened
  // downward and ran off the bottom of the window.
  test('the change menus stay inside the window on a short viewport', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 520 });
    await page.goto(HARNESS);
    await page.evaluate(() => {
      const mk = (id: string, label: string) => ({ id, label, connected: true });
      (
        window as unknown as {
          __preferencesStore: { setState: (s: unknown) => void };
        }
      ).__preferencesStore.setState({
        shared: {
          secrets: { claude: [mk('a1', 'work'), mk('a2', 'home')], codex: [mk('c1', 'codex')] },
        },
      });
    });
    await park(page, { scope: 'session' });
    const composer = (await page.getByTestId('composer').boundingBox())!;
    for (const kind of ['account', 'provider']) {
      await page.getByTestId(`rate-limit-change-${kind}`).click();
      const menu = page.getByTestId(`rate-limit-${kind}-menu`);
      await expect(menu).toBeVisible();
      const box = (await menu.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(composer.y);
      await page.getByTestId(`rate-limit-change-${kind}`).click();
    }
  });

  test('is one state: the interrupted line and red failure are not drawn under the card', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.evaluate(() => {
      const w = window as unknown as {
        __store: { getState: () => { applyEvent: (e: unknown) => void } };
      };
      w.__store.getState().applyEvent({
        type: 'chat.message',
        chatId: 'chat_md',
        role: 'user',
        content: 'go on then',
        seq: 9000,
      });
      w.__store.getState().applyEvent({
        type: 'chat.message',
        chatId: 'chat_md',
        role: 'system',
        content: 'No response requested.',
        synthetic: true,
        seq: 9001,
      });
      w.__store.getState().applyEvent({
        type: 'chat.error',
        chatId: 'chat_md',
        error: { code: 'sdk_error', message: "You've hit your session limit" },
        seq: 9002,
      });
      w.__store.getState().applyEvent({
        type: 'chat.error',
        chatId: 'chat_md',
        error: { code: 'daemon_unavailable', message: 'Connection to the host was lost.' },
        seq: -1,
      });
    });
    // Before the card is up, both are shown — this is the three-things state.
    await expect(page.getByTestId('synthetic-notice')).toHaveCount(1);
    await expect(page.getByTestId('turn-failed')).toHaveCount(1);
    await expect(page.getByTestId('turn-error')).toHaveCount(1);

    await park(page, { scope: 'session' });
    await expect(page.getByTestId('rate-limit-bar')).toBeVisible();
    await expect(page.getByTestId('synthetic-notice')).toHaveCount(0);
    await expect(page.getByTestId('turn-error')).toHaveCount(0);
    // The bubble's own retry mark stays (limit-notice-unparked.spec).
    await expect(page.getByTestId('turn-failed')).toHaveCount(1);
  });

  test('Extra usage links out while off and is greyed, not hidden, once on', async ({ page }) => {
    await page.goto(HARNESS);
    await park(page, { scope: 'week' });
    const extra = page.getByTestId('rate-limit-extra-usage');
    await expect(extra).toBeVisible();
    await expect(extra).toHaveAttribute('aria-disabled', 'true');
    await expect(extra).toHaveAttribute('title', 'Extra usage is already on');

    await park(page, {
      scope: 'session',
      overageBlocked: true,
      overageReason: 'org_level_disabled_until',
    });
    // A link, not a switch: patch cannot flip an Anthropic account setting.
    await expect(extra).toHaveAttribute('href', /claude\.ai/);
  });

  test('carries the auto-resume choice, ticked', async ({ page }) => {
    await page.goto(HARNESS);
    await park(page, { scope: 'session' });
    await expect(page.getByTestId('rate-limit-auto-resume')).toBeChecked();
  });
});
