import { test, expect, type Page } from '@playwright/test';

// Meeting mode (components/MeetingPanel.tsx). The harness has no host, so the
// spec plays the host's side: it reads what the surface sends from
// `window.__wsSent` and answers by applying `meeting.state` to the store.

// Chromium's fake microphone, auto-granted, so capture runs for real.
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

const URL_LIVE = '/app/dev-harness.html?chat=chat_tools&meeting=live';

const sent = (page: Page, type: string) =>
  page.evaluate(
    (t) =>
      (window as unknown as { __wsSent: Array<{ type: string }> }).__wsSent.filter(
        (e) => e.type === t,
      ),
    type,
  );

test.describe('meeting mode — live', () => {
  test('lays the panel beside the chat, with actions above the composer', async ({ page }) => {
    await page.goto(URL_LIVE);
    const panel = page.getByTestId('meeting-panel');
    await expect(panel).toBeVisible();
    const [stream, composer, pan, actions] = await Promise.all([
      page.getByTestId('chat-stream').boundingBox(),
      page.getByTestId('composer').boundingBox(),
      panel.boundingBox(),
      page.getByTestId('meeting-actions').boundingBox(),
    ]);
    expect(pan!.x).toBeGreaterThanOrEqual(stream!.x + stream!.width - 1);
    expect(pan!.width).toBeGreaterThan(290);
    expect(pan!.width).toBeLessThan(420);
    expect(actions!.y).toBeGreaterThan(stream!.y);
    expect(actions!.y + actions!.height).toBeLessThanOrEqual(composer!.y + 1);
    // the composer stays in the chat column, not under the panel
    expect(composer!.x + composer!.width).toBeLessThanOrEqual(pan!.x + 1);
  });

  test('Now is a bar across the top, above both the chat and the side panel', async ({ page }) => {
    await page.goto(URL_LIVE);
    const [bar, now, stream, pan] = await Promise.all([
      page.getByTestId('meeting-bar').boundingBox(),
      page.getByTestId('meeting-now').boundingBox(),
      page.getByTestId('chat-stream').boundingBox(),
      page.getByTestId('meeting-panel').boundingBox(),
    ]);
    expect(bar!.y + bar!.height).toBeLessThanOrEqual(stream!.y + 1);
    expect(bar!.y + bar!.height).toBeLessThanOrEqual(pan!.y + 1);
    expect(bar!.width).toBeGreaterThan(stream!.width + pan!.width - 2);
    expect(now!.y).toBeGreaterThanOrEqual(bar!.y);
    await expect(page.getByTestId('meeting-panel').getByTestId('meeting-now')).toHaveCount(0);
  });

  test('key points and transcript share the one side panel', async ({ page }) => {
    await page.goto(URL_LIVE);
    const panel = page.getByTestId('meeting-panel');
    await expect(panel.getByTestId('meeting-points')).toBeVisible();
    await expect(panel.getByTestId('meeting-transcript')).toBeVisible();
    await expect(page.getByTestId('meeting-line').first()).toBeVisible();
  });

  test('transcript stays pinned to the latest line until Tom scrolls up', async ({ page }) => {
    await page.goto(URL_LIVE);
    const add = (n: number, start: number) =>
      page.evaluate(
        ([count, from]) => {
          const store = (window as unknown as { __meetingStore: any }).__meetingStore;
          const cur = store.getState().byChat['chat_tools'];
          const more = Array.from({ length: count }, (_, i) => ({
            at: (from + i) * 1000,
            speaker: 'them',
            text: `filler line ${from + i}`,
          }));
          store.getState().apply('chat_tools', {
            ...cur,
            transcript: [...cur.transcript, ...more],
          });
        },
        [n, start],
      );
    const lines = page.getByTestId('meeting-lines');
    const gap = () => lines.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await add(60, 100);
    await expect.poll(gap).toBeLessThan(5);
    await add(5, 200);
    await expect.poll(gap).toBeLessThan(5);
    await lines.evaluate((el) => {
      el.scrollTop = 0;
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    await add(5, 300);
    expect(await gap()).toBeGreaterThan(100);
    await lines.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    await add(5, 400);
    await expect.poll(gap).toBeLessThan(5);
  });

  test('shows Live + timer, Now, topics newest first with Decided badges', async ({ page }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-pill')).toContainText(/Live · 3\d:\d\d/);
    await expect(page.getByTestId('meeting-now')).toContainText('Dev is arguing the ledger split');
    await expect(page.getByTestId('meeting-now')).toContainText('Dev, Priya');
    const topics = page.getByTestId('meeting-topic');
    await expect(topics).toHaveCount(3);
    await expect(topics.first()).toContainText("Sam's failing tests");
    await expect(topics.last()).toContainText('Release 4.2');
    await expect(page.locator('.mm-dec')).toHaveCount(2);
  });

  test('Now shows the provisional live line, and the speed option tunes the host', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-live')).toHaveCount(0);
    await page.evaluate(() => {
      const store = (window as unknown as { __meetingStore: any }).__meetingStore;
      const cur = store.getState().byChat['chat_tools'];
      store.getState().apply('chat_tools', { ...cur, live: 'so can we ship on Friday' });
    });
    await expect(page.getByTestId('meeting-live')).toHaveText('so can we ship on Friday');
    await page.getByTestId('meeting-speed').selectOption('fast');
    const reqs = (await sent(page, 'meeting.control_request')) as Array<{
      action: string;
      settings?: { clipSeconds: number; analyseSeconds: number };
    }>;
    expect(reqs.at(-1)).toMatchObject({
      action: 'tune',
      settings: { clipSeconds: 3, analyseSeconds: 8 },
    });
  });

  test('the live timer ticks', async ({ page }) => {
    await page.goto(URL_LIVE);
    const a = await page.getByTestId('meeting-pill').innerText();
    await expect
      .poll(() => page.getByTestId('meeting-pill').innerText(), { timeout: 5000 })
      .not.toBe(a);
  });

  test('transcript is always open and searchable', async ({ page }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-line')).toHaveCount(2);
    await page.getByTestId('meeting-search').fill('statement');
    await expect(page.getByTestId('meeting-line')).toHaveCount(1);
    await expect(page.getByTestId('meeting-line')).toContainText('You');
  });

  test('action cards: pending ones have Do it / Dismiss, done ones collapse to a tick', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const cards = page.getByTestId('meeting-action');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toHaveAttribute('data-status', 'pending');
    await expect(cards.nth(2)).toHaveAttribute('data-status', 'done');
    await expect(cards.nth(2)).toContainText('✓');
    await expect(cards.nth(2).getByTestId('meeting-action-do')).toHaveCount(0);

    await cards.nth(0).getByTestId('meeting-action-do').click();
    await cards.nth(1).getByTestId('meeting-action-dismiss').click();
    const reqs = (await sent(page, 'meeting.action_request')) as Array<{
      actionId: string;
      decision: string;
    }>;
    expect(reqs.map((r) => [r.actionId, r.decision])).toEqual([
      ['a1', 'do'],
      ['a2', 'dismiss'],
    ]);
  });

  test('a card stays until the host says it is done, then collapses to a tick; dismissed ones vanish', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.evaluate(() => {
      const store = (window as unknown as { __meetingStore: { getState(): any } }).__meetingStore;
      const m = store.getState().byChat['chat_tools'];
      store.getState().apply('chat_tools', {
        ...m,
        actions: m.actions.map((a: any) =>
          a.id === 'a1'
            ? { ...a, status: 'done', resolvedAt: Date.now() }
            : a.id === 'a2'
              ? { ...a, status: 'dismissed', resolvedAt: Date.now() }
              : a,
        ),
      });
    });
    const cards = page.getByTestId('meeting-action');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAttribute('data-status', 'done');
  });

  test('Pause, Resume and End send the controls', async ({ page }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-pause').click();
    await page.evaluate(() => {
      const store = (window as unknown as { __meetingStore: { getState(): any } }).__meetingStore;
      const m = store.getState().byChat['chat_tools'];
      const { resumedAt: _r, ...rest } = m;
      store.getState().apply('chat_tools', { ...rest, status: 'paused', elapsedBaseMs: 60_000 });
    });
    await expect(page.getByTestId('meeting-pill')).toContainText('Paused · 01:00');
    await page.getByTestId('meeting-resume').click();
    await page.getByTestId('meeting-end').click();
    const actions = (
      (await sent(page, 'meeting.control_request')) as Array<{ action: string }>
    ).map((e) => e.action);
    expect(actions).toEqual(['pause', 'resume', 'end']);
  });

  test('a live meeting this device is not capturing says so, and offers Listen here', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-not-listening')).toBeVisible();
    await expect(page.getByTestId('meeting-listen-here')).toBeVisible();
  });

  test('a host error is shown on the panel', async ({ page }) => {
    await page.goto(URL_LIVE);
    await page.evaluate(() => {
      const store = (window as unknown as { __meetingStore: { getState(): any } }).__meetingStore;
      const m = store.getState().byChat['chat_tools'];
      store.getState().apply('chat_tools', { ...m, error: 'analysis failed: no credit' });
    });
    await expect(page.getByTestId('meeting-error')).toContainText('no credit');
  });
});

test.describe('meeting mode — after', () => {
  test('shows Ended + duration and a Summary in place of Now; pending actions stay; chat carries on', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_tools&meeting=ended');
    await expect(page.getByTestId('meeting-pill')).toHaveText('Ended · 52 min');
    await expect(page.getByTestId('meeting-now')).toContainText('Summary');
    await expect(page.getByTestId('meeting-now')).toContainText(
      'Ledger split goes ahead in November',
    );
    await expect(page.getByTestId('meeting-pause')).toHaveCount(0);
    await expect(page.getByTestId('meeting-end')).toHaveCount(0);
    await expect(page.getByTestId('meeting-action-do')).toHaveCount(2);
    await expect(page.getByTestId('composer-input')).toBeEnabled();
    // Ended: the button offers a new meeting, not End.
    await expect(page.getByTestId('meeting-btn')).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('meeting mode — start', () => {
  test('the Meeting button sits beside Call', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_tools');
    const call = await page.getByTestId('call-btn').boundingBox();
    const meeting = await page.getByTestId('meeting-btn').boundingBox();
    expect(meeting!.x).toBeGreaterThan(call!.x);
    expect(Math.abs(meeting!.y - call!.y)).toBeLessThan(2);
    await expect(page.getByTestId('meeting-panel')).toHaveCount(0);
  });

  test('a denied microphone starts no meeting and says why', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('Permission denied'));
    });
    await page.goto('/app/dev-harness.html?chat=chat_tools');
    await page.getByTestId('meeting-btn').click();
    await expect(page.getByText(/Could not start the meeting/)).toBeVisible();
    expect(await sent(page, 'meeting.control_request')).toHaveLength(0);
  });
});

test.describe('meeting mode — capture with a real (fake) microphone', () => {
  test('start asks the host to start; audio goes up as WAV clips; End flushes them before it ends', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_tools');
    await page.getByTestId('meeting-btn').click();
    await expect.poll(async () => (await sent(page, 'meeting.control_request')).length).toBe(1);
    expect(((await sent(page, 'meeting.control_request'))[0] as { action: string }).action).toBe(
      'start',
    );
    // The host answers; the panel opens and the button becomes End.
    await page.evaluate(() => {
      const store = (window as unknown as { __meetingStore: { getState(): any } }).__meetingStore;
      store.getState().apply('chat_tools', {
        status: 'live',
        startedAt: Date.now(),
        elapsedBaseMs: 0,
        resumedAt: Date.now(),
        now: null,
        summary: null,
        topics: [],
        actions: [],
        transcript: [],
        error: null,
      });
    });
    await expect(page.getByTestId('meeting-panel')).toBeVisible();
    await expect(page.getByTestId('meeting-now')).toContainText('Listening');
    await expect(page.getByTestId('meeting-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('meeting-not-listening')).toHaveCount(0);

    // Ending flushes the partial clip ahead of the end request.
    await page.waitForTimeout(3000);
    await page.getByTestId('meeting-end').click();
    const events = (
      await page.evaluate(
        () =>
          (
            window as unknown as {
              __wsSent: Array<{
                type: string;
                source?: string;
                audioBase64?: string;
                action?: string;
              }>;
            }
          ).__wsSent,
      )
    ).filter((e) => e.type.startsWith('meeting.'));
    const audio = events.filter((e) => e.type === 'meeting.audio');
    expect(audio.length).toBeGreaterThanOrEqual(1);
    expect(audio[0]!.source).toBe('mic');
    expect(Buffer.from(audio[0]!.audioBase64!, 'base64').subarray(0, 4).toString()).toBe('RIFF');
    expect(events.at(-1)).toMatchObject({ type: 'meeting.control_request', action: 'end' });
  });
});

test.describe('meeting mode — editing prompts mid-call', () => {
  test('a section label opens its prompt, and Save writes it without leaving the meeting', async ({
    page,
  }) => {
    const writes: Record<string, unknown>[] = [];
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      writes.push(body);
      const prefs = await page.evaluate(
        () =>
          (
            window as unknown as {
              __preferencesStore: { getState: () => { preferences: object } };
            }
          ).__preferencesStore.getState().preferences,
      );
      await route.fulfill({ json: { preferences: { ...prefs, ...body } } });
    });
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-prompt-editor')).toHaveCount(0);
    await page.getByTestId('meeting-edit-now').click();
    const box = page.getByTestId('meeting-prompt-text');
    await expect(box).toContainText('headline');
    await box.fill('Only a headline.');
    await page.getByTestId('meeting-prompt-save').click();
    await expect(page.getByTestId('meeting-prompt-editor')).toHaveCount(0);
    expect(writes).toEqual([{ meetingNowPrompt: 'Only a headline.' }]);
    // still on the meeting page, still live
    await expect(page.getByTestId('meeting-panel')).toBeVisible();
    // the always-present Prompts button reaches the other two via tabs
    await page.getByTestId('meeting-prompts').click();
    await page.getByTestId('meeting-prompt-tab-actions').click();
    await expect(page.getByTestId('meeting-prompt-text')).toContainText('"actions"');
    await page.getByTestId('meeting-prompt-reset').click();
    await expect(page.getByTestId('meeting-prompt-editor')).toHaveCount(0);
    expect(writes).toHaveLength(2);
    expect(Object.keys(writes[1]!)).toEqual(['meetingActionsPrompt']);
  });
});
