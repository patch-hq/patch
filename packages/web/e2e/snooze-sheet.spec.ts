import { test, expect, type Page } from '@playwright/test';

// Real-browser e2e (dev harness, real Sidebar/ChatHeader/SnoozeSheet + real
// CSS, no backend) for spec/04 § Snooze and spec/14 § Snooze sheet: the sheet
// opened from the header and from the folder clock, preset selection and button
// copy, the "Run in background" box, the confirmation toast with Undo, the
// snoozed line folded into its project, and the Back state (pill, row lines,
// clearing as a set, the permanent transcript divider).
//
// The host owns outcomes and clearing (host/test/snooze-back.test.ts); here the
// REST routes are stubbed and the host's broadcast is played through the real
// reducer, so what is proved is what a browser draws and sends.
const HARNESS = '/app/dev-harness.html?chat=chat_md';
const FOLDER = '/home/tom/projects/work';
const HOUR = 3_600_000;

type Row = Record<string, unknown>;

function row(chatId: string, name: string, over: Row = {}): Row {
  return {
    chatId,
    hostId: 'd1',
    permissionMode: 'auto',
    name,
    folder: FOLDER,
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 10,
    lastUserActivity: 10,
    ...over,
  };
}

async function seed(page: Page, rows: Row[]): Promise<void> {
  await page.goto(HARNESS);
  await page.evaluate((r) => {
    const w = window as unknown as { __store: { getState(): { hydrate(rows: unknown[]): void } } };
    w.__store.getState().hydrate(r);
  }, rows);
}

async function stubSnooze(page: Page): Promise<Array<{ chatId: string; body: Row }>> {
  const calls: Array<{ chatId: string; body: Row }> = [];
  await page.route('**/api/chats/*/snooze', async (route) => {
    const chatId = route.request().url().split('/api/chats/')[1]!.split('/')[0]!;
    calls.push({ chatId, body: route.request().postDataJSON() as Row });
    await route.fulfill({ json: { ok: true } });
  });
  return calls;
}

const THREE = (running: Row = {}): Row[] => [
  row('chat_md', 'Migrate billing', {
    activity: 'running',
    runningSince: Date.now() - 130 * 60_000,
    statusSummary: 'Shadow run, pass 1 of ~4',
    ...running,
  }),
  row('w2', 'Fix flaky checkout', { activity: 'running', runningSince: Date.now() - 25 * 60_000 }),
  row('w3', 'Tempo timesheet'),
];

test.describe('snooze sheet', () => {
  test('opens from the chat header; nothing is chosen until a preset is', async ({ page }) => {
    // Presets that land within 15 minutes of an earlier one are hidden, so pin a
    // midweek morning where all seven are distinct (on a Sunday, Tomorrow 8am
    // and Next Monday coincide).
    await page.clock.setFixedTime(new Date('2026-10-21T10:00:00Z'));
    await seed(page, THREE());
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    const sheet = page.getByTestId('snooze-sheet');
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId('snooze-sheet-title')).toHaveText('Snooze');
    await expect(page.getByTestId('snooze-sheet-subtitle')).toHaveText('Migrate billing');
    for (const label of [
      '30 minutes',
      '1 hour',
      '5pm',
      'Tomorrow 8am',
      '1 day',
      'Next Monday',
      'Custom…',
    ]) {
      await expect(sheet.getByText(label, { exact: true })).toBeVisible();
    }
    // Each preset names the moment it resolves to.
    await expect(page.getByTestId('snooze-sheet-preset-1-hour')).toContainText(
      /\d\d:\d\d|[A-Z][a-z]{2} /,
    );
    const confirm = page.getByTestId('snooze-sheet-confirm');
    await expect(confirm).toHaveText('Snooze');
    await expect(confirm).toBeDisabled();
    await page.getByTestId('snooze-sheet-preset-1-hour').click();
    await expect(confirm).toBeEnabled();
    await expect(confirm).toHaveText(/^Snooze until (\d\d:\d\d|[A-Z][a-z]{2} .+)$/);
    await expect(
      page.getByText('Snoozed chats keep running and reappear when scheduled'),
    ).toBeVisible();
    // Fully on screen.
    const box = (await sheet.boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  });

  test('Until complete is offered for a running chat and sends the sentinel', async ({ page }) => {
    const calls = await stubSnooze(page);
    await seed(page, THREE());
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    await page.getByTestId('snooze-sheet-preset-until-complete').click();
    await expect(page.getByTestId('snooze-sheet-confirm')).toHaveText('Snooze until complete');
    await page.getByTestId('snooze-sheet-confirm').click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]!.body.snoozedUntil).toBe(8_640_000_000_000_000);
    await expect(page.getByText('snoozed until complete')).toBeVisible();
  });

  test('Until complete is not offered when the chat has nothing running', async ({ page }) => {
    await seed(page, THREE({ activity: 'idle' }));
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    await expect(page.getByTestId('snooze-sheet-preset-1-hour')).toBeVisible();
    await expect(page.getByTestId('snooze-sheet-preset-until-complete')).toHaveCount(0);
  });

  test('Esc and the scrim cancel without snoozing', async ({ page }) => {
    const calls = await stubSnooze(page);
    await seed(page, THREE());
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('snooze-sheet')).toHaveCount(0);
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    await page.getByTestId('snooze-sheet-scrim').click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId('snooze-sheet')).toHaveCount(0);
    expect(calls).toEqual([]);
  });

  test('Custom… reveals the date field and refuses a past time', async ({ page }) => {
    const calls = await stubSnooze(page);
    await seed(page, THREE());
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    await page.getByTestId('snooze-sheet-preset-custom').click();
    const input = page.getByTestId('snooze-sheet-custom-input');
    await expect(input).toBeVisible();
    await input.fill('2020-01-01T09:00');
    await page.getByTestId('snooze-sheet-confirm').click();
    await expect(page.getByText('snooze: pick a time in the future')).toBeVisible();
    expect(calls).toEqual([]);
    await expect(page.getByTestId('snooze-sheet')).toBeVisible();
  });

  test('the Run in background box lists only running chats, with elapsed time', async ({
    page,
  }) => {
    await seed(page, THREE());
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    const box = page.getByTestId('snooze-sheet-run');
    await expect(box).toBeVisible();
    await expect(box).toContainText('Run in background');
    await expect(box.getByTestId('snooze-sheet-run-item')).toHaveCount(1);
    await expect(box).toContainText('This chat');
    await expect(box).toContainText('Shadow run, pass 1 of ~4');
    await expect(box).toContainText('2h 10m');
    await expect(box).not.toContainText('not running');
  });

  test('no box when nothing in the set is running', async ({ page }) => {
    await seed(
      page,
      THREE({ activity: 'idle', statusSummary: null }).map((r) => ({ ...r, activity: 'idle' })),
    );
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    await expect(page.getByTestId('snooze-sheet')).toBeVisible();
    await expect(page.getByTestId('snooze-sheet-run')).toHaveCount(0);
  });

  test('the folder clock opens the project sheet with its running chats and the rest counted', async ({
    page,
  }) => {
    await seed(page, THREE());
    await page.getByTestId(`folder-snooze-${FOLDER}`).click({ force: true });
    await expect(page.getByTestId('snooze-sheet-title')).toHaveText('Snooze work');
    await expect(page.getByTestId('snooze-sheet-subtitle')).toHaveText('3 chats');
    const box = page.getByTestId('snooze-sheet-run');
    await expect(box.getByTestId('snooze-sheet-run-item')).toHaveCount(2);
    await expect(box).toContainText('Migrate billing');
    await expect(box).toContainText('Fix flaky checkout');
    await expect(box).toContainText('25m');
    await expect(box).toContainText('+ 1 not running');
    await page.getByTestId('snooze-sheet-preset-tomorrow-8am').click();
    await expect(page.getByTestId('snooze-sheet-confirm')).toHaveText(/^Snooze 3 until /);
  });

  test('confirming folds the chats into one line in their project, toasts, and Undo restores', async ({
    page,
  }) => {
    const calls = await stubSnooze(page);
    // Pinned: near 08:00 the wall clock hides 1 day / Tomorrow 8am as duplicates.
    await page.clock.setFixedTime(new Date('2026-10-21T10:00:00Z'));
    await seed(page, THREE());
    await page.getByTestId(`folder-snooze-${FOLDER}`).click({ force: true });
    await page.getByTestId('snooze-sheet-preset-1-day').click();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('snooze-sheet')).toHaveCount(0);

    // One request per chat, one set id between them, an absolute wake time.
    await expect.poll(() => calls.length).toBe(3);
    const setIds = new Set(calls.map((c) => c.body['setId']));
    expect(setIds.size).toBe(1);
    expect(typeof calls[0]!.body['snoozedUntil']).toBe('number');

    await expect(page.getByTestId(`folder-snoozed-${FOLDER}`)).toHaveCount(0);
    await expect(page.getByTestId('chat-row-w2')).toHaveCount(0);
    await expect(page.getByTestId('snoozed-pip')).toHaveCount(0);

    const toast = page.getByTestId('snooze-toast');
    await expect(toast).toContainText('work snoozed until');
    await expect(toast).toContainText('2 chats running in background');

    await page.getByTestId('snooze-toast-undo').click();
    await expect(page.getByTestId('chat-row-w2')).toBeVisible();
    await expect.poll(() => calls.length).toBe(6);
    expect(calls.slice(3).every((c) => c.body['snoozedUntil'] === null)).toBe(true);
  });

  test('a single running chat says it runs in the background; an idle one says nothing', async ({
    page,
  }) => {
    await stubSnooze(page);
    await seed(page, THREE());
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    await page.getByTestId('snooze-sheet-preset-30-minutes').click();
    await page.getByTestId('snooze-sheet-confirm').click();
    const toast = page.getByTestId('snooze-toast');
    await expect(toast).toContainText('Migrate billing snoozed until');
    await expect(toast).toContainText('Running in background');
  });

  test('a folder with only snoozed chats is not shown', async ({ page }) => {
    await seed(page, [
      row('chat_md', 'Elsewhere', { folder: '/home/tom/projects/other' }),
      row('w2', 'Fix flaky checkout', { snoozedUntil: Date.now() + 2 * HOUR }),
    ]);
    await expect(page.locator('.folder-head-label', { hasText: /^work$/ })).toHaveCount(0);
  });
});

test.describe('back from a snooze', () => {
  const LAPSED = async (page: Page): Promise<void> => {
    await page.route('**/api/chats/*/snooze/back-clear', async (route) => {
      const url = route.request().url();
      cleared.push(url.split('/api/chats/')[1]!.split('/')[0]!);
      await route.fulfill({ json: { ok: true } });
      // The host clears the whole set and broadcasts every chat.
      for (const id of ['chat_table', 'w2', 'w3']) {
        await page.evaluate((chatId) => {
          const w = window as unknown as {
            __store: {
              getState(): {
                applyEvent(e: unknown): void;
                chats: Record<string, { snoozeRecords?: unknown[] }>;
              };
            };
          };
          const s = w.__store.getState();
          const recs = (s.chats[chatId]?.snoozeRecords ?? []) as Array<Record<string, unknown>>;
          s.applyEvent({
            type: 'chat.state',
            chatId,
            activity: 'idle',
            permissionMode: 'auto',
            lastUpdated: 10,
            status: 'active',
            snoozeRecords: recs.map((r) => ({ ...r, backCleared: true })),
          });
        }, id);
      }
    });
    // chat_md is the chat on screen and is NOT in the set: opening the set's
    // chats is what clears it.
    await seed(page, [
      row('chat_md', 'On screen', { folder: '/home/tom/projects/other' }),
      row('chat_table', 'Migrate billing'),
      row('w2', 'Fix flaky checkout'),
      row('w3', 'Tempo timesheet'),
    ]);
    const mk = (over: Row): Row => ({
      setId: 'set-1',
      startedAt: 0,
      startSeq: 0,
      until: 0,
      backCleared: false,
      ...over,
    });
    await page.evaluate(
      ([a, b, c]) => {
        const w = window as unknown as {
          __store: { getState(): { applyEvent(e: unknown): void } };
        };
        const end = Date.now() - 60_000;
        const fix = (r: Record<string, unknown>, outcome: Record<string, unknown>) => ({
          ...r,
          startedAt: end - 12 * 3_600_000,
          until: end,
          endedAt: end,
          outcome,
        });
        const at = (h: number, m: number) => new Date(2026, 9, 15, h, m).getTime();
        const recs: Record<string, unknown> = {
          chat_table: fix(a as Record<string, unknown>, { kind: 'finished', at: at(3, 52) }),
          w2: fix(b as Record<string, unknown>, { kind: 'waiting', at: at(21, 14) }),
          w3: fix(c as Record<string, unknown>, { kind: 'none' }),
        };
        for (const [chatId, rec] of Object.entries(recs)) {
          w.__store.getState().applyEvent({
            type: 'chat.state',
            chatId,
            activity: 'idle',
            permissionMode: 'auto',
            lastUpdated: 10,
            status: 'active',
            snoozedUntil: null,
            snoozeRecords: [rec],
          });
        }
      },
      [mk({}), mk({}), mk({})],
    );
  };
  const cleared: string[] = [];
  test.beforeEach(() => {
    cleared.length = 0;
  });

  test('the project says it is back, and each returned row says what happened', async ({
    page,
  }) => {
    await LAPSED(page);
    await expect(page.getByTestId(`folder-back-${FOLDER}`)).toHaveText('back · snoozed 12h');
    // No close control on it.
    await expect(page.getByTestId(`folder-back-${FOLDER}`).locator('button')).toHaveCount(0);
    await expect(page.getByTestId('snooze-back-line-chat_table')).toHaveText('finished 03:52');
    await expect(page.getByTestId('snooze-back-line-w2')).toHaveText('waiting on you since 21:14');
    // `none` has an inset but no line.
    await expect(page.getByTestId('snooze-back-line-w3')).toHaveCount(0);
    for (const id of ['chat_table', 'w2', 'w3']) {
      await expect(page.getByTestId(`chat-row-${id}`)).toHaveClass(/snooze-back-row/);
    }
  });

  test('opening one chat clears the pill, the insets and the lines for the whole set; the divider stays', async ({
    page,
  }) => {
    await LAPSED(page);
    await page.getByTestId('chat-row-chat_table').click();
    await expect.poll(() => cleared.length).toBeGreaterThan(0);
    expect(cleared).toContain('chat_table');
    await expect(page.getByTestId(`folder-back-${FOLDER}`)).toHaveCount(0);
    await expect(page.locator('.snooze-back-row')).toHaveCount(0);
    await expect(page.locator('.snooze-back-line')).toHaveCount(0);
    // The record of it stays in the transcript, with what happened.
    const divider = page.getByTestId('snooze-divider');
    await expect(divider).toBeVisible();
    await expect(divider).toContainText(/^Snoozed .+ – \d\d:\d\d · finished .+$/);
  });
});
