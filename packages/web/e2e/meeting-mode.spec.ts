import { test, expect, type Page } from '@playwright/test';

// Meeting mode (components/MeetingPanel.tsx, design/meeting-mode-v4). The harness has no host, so the
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

/** Plays the host: merges `patch` into the chat's meeting as a `meeting.state` would. */
const applyMeeting = (page: Page, patch: Record<string, unknown>) =>
  page.evaluate((p) => {
    const store = (window as unknown as { __meetingStore: any }).__meetingStore;
    const cur = store.getState().byChat['chat_tools'];
    store.getState().apply('chat_tools', { ...cur, ...p });
  }, patch);

const openActions = (page: Page) => page.getByTestId('meeting-tab-actions').click();

test.describe('meeting mode — live', () => {
  test('the chat stays a plain chat, with the meeting in a panel on its right', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const panel = page.getByTestId('meeting-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('chat-stream')).toBeVisible();
    const [stream, composer, pan] = await Promise.all([
      page.getByTestId('chat-stream').boundingBox(),
      page.getByTestId('composer').boundingBox(),
      panel.boundingBox(),
    ]);
    expect(pan!.x).toBeGreaterThanOrEqual(stream!.x + stream!.width - 1);
    expect(pan!.width).toBeGreaterThanOrEqual(320);
    expect(pan!.width).toBeLessThanOrEqual(460);
    expect(stream!.height).toBeGreaterThan(page.viewportSize()!.height * 0.5);
    // nothing of the meeting between the messages and the composer
    expect(composer!.y - (stream!.y + stream!.height)).toBeLessThan(40);
    expect(composer!.x + composer!.width).toBeLessThanOrEqual(pan!.x + 1);
    // the composer is the chat's: no Note / Ask switch
    await expect(page.getByTestId('meeting-mode-note')).toHaveCount(0);
    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      'Ask about the meeting…',
    );
  });

  test('the panel is flush: no padding, box or rounding, only a hairline on its left', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const panel = page.getByTestId('meeting-panel');
    const [pan, body] = await Promise.all([
      panel.boundingBox(),
      page.getByTestId('meeting-body').boundingBox(),
    ]);
    expect(pan!.x + pan!.width).toBeGreaterThanOrEqual(body!.x + body!.width - 1);
    const st = await panel.evaluate((el) => {
      const c = getComputedStyle(el);
      return {
        pad: [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft],
        border: [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth],
        radius: c.borderTopLeftRadius,
      };
    });
    expect(st.pad).toEqual(['0px', '0px', '0px', '0px']);
    expect(st.border).toEqual(['0px', '0px', '0px', '1px']);
    expect(st.radius).toBe('0px');
  });

  test('the header is one row over the tabs: timer, people, Pause, End, settings', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const ids = ['meeting-pill', 'meeting-people', 'meeting-pause', 'meeting-end', 'meeting-cog'];
    const boxes = await Promise.all(ids.map((id) => page.getByTestId(id).boundingBox()));
    const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
    for (const b of boxes) expect(Math.abs(mid(b!) - mid(boxes[0]!))).toBeLessThan(4);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x);
    const [head, tabs] = await Promise.all([
      page.getByTestId('meeting-panel').getByTestId('meeting-bar').boundingBox(),
      page.getByRole('tablist').boundingBox(),
    ]);
    expect(head!.y + head!.height).toBeLessThanOrEqual(tabs!.y + 1);
    // the timer has no "Live" word: the red dot says it
    await expect(page.getByTestId('meeting-pill')).toHaveText(/^3\d:\d\d$/);
    await expect(page.getByTestId('meeting-pill').locator('.mm-dot')).toBeVisible();
  });

  test('tabs are Notes, My notes, Actions with its count, and Transcript, at 15px', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveText(['Notes', 'My notes', /^Actions\s*3$/, 'Transcript']);
    await expect(page.getByTestId('meeting-tab-notes')).toHaveAttribute('aria-selected', 'true');
    expect(await tabs.first().evaluate((el) => getComputedStyle(el).fontSize)).toBe('15px');
    await page.getByTestId('meeting-tab-mine').click();
    await expect(page.getByTestId('meeting-points')).toHaveCount(0);
    await expect(page.getByTestId('meeting-my-notes')).toBeVisible();
  });

  test('at 390px the panel stacks under the chat with no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(URL_LIVE);
    const overflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(await overflow()).toBe(false);
    const [stream, pan] = await Promise.all([
      page.getByTestId('chat-stream').boundingBox(),
      page.getByTestId('meeting-panel').boundingBox(),
    ]);
    expect(pan!.y).toBeGreaterThanOrEqual(stream!.y + stream!.height - 1);
    expect(pan!.x + pan!.width).toBeLessThanOrEqual(390);
    await page.getByTestId('meeting-cog').click();
    expect(await overflow()).toBe(false);
  });

  test('the header names who is on the call, unnamed voices counted as unknown', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await applyMeeting(page, {
      transcript: [
        { at: 1000, speaker: 'them', name: 'Ada', text: 'hello' },
        { at: 2000, speaker: 'them', name: 'Bo', text: 'hi' },
        { at: 3000, speaker: 'them', text: 'unnamed' },
        { at: 4000, speaker: 'you', text: 'ok' },
      ],
    });
    await expect(page.getByTestId('meeting-people')).toHaveText('Ada · Bo · You · 1 unknown');
    await expect(page.getByTestId('meeting-bar')).not.toContainText(/auto-?end/i);
  });

  test('Notes run oldest first: points and research at their times, the newest point marked Now', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const view = page.getByTestId('meeting-points');
    const times = await view
      .locator('[data-testid=meeting-topic] > .tm, [data-testid=meeting-card] .mm-card-t')
      .allInnerTexts();
    expect(times).toEqual(['00:30', '17:33', '22:05', '23:41', '24:46', '31:40']);
    // Tom's own notes have their own tab
    await expect(view.getByTestId('meeting-note')).toHaveCount(0);
    const topics = page.getByTestId('meeting-topic');
    await expect(topics).toHaveCount(3);
    const now = page.locator('[data-testid=meeting-topic][data-now=true]');
    await expect(now).toHaveCount(1);
    await expect(now).toContainText('Now');
    await expect(now).toContainText('failing tests');
    // Decisions are marked in the text; no chips, no Edit buttons, no "add a point"
    await expect(topics.locator('.decw')).toHaveCount(2);
    await expect(page.getByTestId('meeting-point-insert')).toHaveCount(0);
    await expect(
      view.getByRole('button', { name: /^(Edit|Add bullet|Add a point here)$/ }),
    ).toHaveCount(0);
  });

  test("My notes are Tom's own, in full ink at 15px; generated points are softer", async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const ink = await page.evaluate(() => {
      const d = document.createElement('div');
      d.style.color = 'var(--ink)';
      document.body.appendChild(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    });
    const style = (sel: string) =>
      page
        .locator(sel)
        .first()
        .evaluate((el) => {
          const c = getComputedStyle(el);
          return [c.color, c.fontSize];
        });
    const [pointInk] = await style('[data-testid=meeting-topic]:not([data-now]) .nm');
    expect(pointInk).not.toBe(ink);
    await page.getByTestId('meeting-tab-mine').click();
    const notes = page.getByTestId('meeting-note');
    await expect(notes).toHaveCount(2);
    await expect(notes.first()).toContainText('ask Marco about the sandbox budget');
    await expect(notes.first()).toContainText('01:40');
    const [noteInk, noteSize] = await style('[data-testid=meeting-note] .nm');
    expect(noteInk).toBe(ink);
    expect(noteSize).toBe('15px');
  });

  test('the newest talk the notes have not taken in yet shows at the bottom, labelled by speaker', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const tail = page.getByTestId('meeting-tail');
    await expect(tail).toContainText('Not in the summary yet');
    const lines = tail.getByTestId('meeting-line');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(0)).toContainText('Unknown');
    await expect(lines.nth(0)).not.toContainText('Them');
    await expect(lines.nth(1)).toContainText('Unknown 2');
    await expect(lines.last()).toHaveClass(/prov/);
    // it is below the Now point
    const [now, t] = await Promise.all([
      page.locator('[data-testid=meeting-topic][data-now=true]').boundingBox(),
      tail.boundingBox(),
    ]);
    expect(t!.y).toBeGreaterThan(now!.y + now!.height - 1);
    // once the notes are current there is nothing left to show
    await applyMeeting(page, { live: null });
    await expect(tail).toHaveCount(0);
  });

  test('Notes stay pinned to the newest item until Tom scrolls up', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(URL_LIVE);
    const scroller = page.getByTestId('meeting-points');
    const gap = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await expect.poll(gap).toBeLessThan(5);
    const add = (n: number) =>
      page.evaluate((k) => {
        const store = (window as unknown as { __meetingStore: any }).__meetingStore;
        const cur = store.getState().byChat['chat_tools'];
        const extra = Array.from({ length: 4 }, (_, i) => ({
          id: `p${k}_${i}`,
          at: 32 * 60_000 + k * 1000 + i,
          title: `Dev: point ${k}.${i}`,
          points: ['detail one', 'detail two'],
          decided: false,
        }));
        store.getState().apply('chat_tools', { ...cur, topics: [...cur.topics, ...extra] });
      }, n);
    await add(1);
    await expect.poll(gap).toBeLessThan(5);
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    await add(2);
    expect(await gap()).toBeGreaterThan(100);
  });

  test('My notes has its own box: Enter writes a timed note and the host stores it; the chat gets nothing', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-tab-mine').click();
    const box = page.getByTestId('meeting-note-input');
    await expect(box).toHaveAttribute('placeholder', 'Write a note…');
    const [list, b] = await Promise.all([
      page.getByTestId('meeting-my-notes').boundingBox(),
      box.boundingBox(),
    ]);
    expect(b!.y).toBeGreaterThanOrEqual(list!.y + list!.height - 1);
    await box.fill('chase the vendor dates');
    await box.press('Enter');
    const notes = page.getByTestId('meeting-note');
    await expect(notes).toHaveCount(3);
    await expect(notes.last()).toContainText('chase the vendor dates');
    await expect(box).toHaveValue('');
    const req = (await sent(page, 'meeting.my_notes_request')).at(-1) as unknown as {
      chatId: string;
      text: string;
    };
    expect(req.chatId).toBe('chat_tools');
    expect(req.text).toMatch(
      /^01:40 ask Marco about the sandbox budget\n22:30 check the flag plan with Priya\n3\d:\d\d chase the vendor dates$/,
    );
    expect(await sent(page, 'chat.input')).toHaveLength(0);
    // an empty box writes nothing
    await box.press('Enter');
    await expect(notes).toHaveCount(3);
  });

  test('a note is edited in place, and emptying it removes it', async ({ page }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-tab-mine').click();
    const text = page.getByTestId('meeting-note-text').first();
    await text.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('ask Marco about budget');
    await page.keyboard.press('Enter');
    expect((await sent(page, 'meeting.my_notes_request')).at(-1)).toMatchObject({
      text: '01:40 ask Marco about budget\n22:30 check the flag plan with Priya',
    });
    await text.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('meeting-note')).toHaveCount(1);
    expect((await sent(page, 'meeting.my_notes_request')).at(-1)).toMatchObject({
      text: '22:30 check the flag plan with Priya',
    });
  });

  test('the composer sends to the agent, as in any chat, and writes no note', async ({ page }) => {
    await page.goto(`${URL_LIVE}&ws=fake`);
    const input = page.getByTestId('composer-input');
    await input.fill('who owns the vendor review?');
    await input.press('Enter');
    await expect.poll(async () => (await sent(page, 'chat.input')).length).toBe(1);
    expect(await sent(page, 'meeting.my_notes_request')).toHaveLength(0);
  });

  test("Tom's questions and the agent's answers stay in the chat, not in the notes", async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.evaluate(() => {
      const chats = (window as unknown as { __chatStore: any }).__chatStore;
      const m = (window as unknown as { __meetingStore: any }).__meetingStore.getState().byChat[
        'chat_tools'
      ];
      chats.setState((st: any) => ({
        timelines: {
          ...st.timelines,
          chat_tools: [
            ...st.timelines.chat_tools,
            {
              seq: 900,
              kind: 'message',
              role: 'user',
              content: 'is 40 cars right?',
              messageAt: m.startedAt + 24 * 60_000,
            },
            {
              seq: 901,
              kind: 'message',
              role: 'assistant',
              content: 'Yes, the **operator** says 40.',
              messageAt: m.startedAt + 24 * 60_000 + 5000,
            },
          ],
        },
      }));
    });
    const stream = page.getByTestId('chat-stream');
    await expect(stream).toContainText('is 40 cars right?');
    await expect(stream.locator('strong', { hasText: 'operator' })).toBeVisible();
    await expect(page.getByTestId('meeting-points')).not.toContainText('is 40 cars right?');
    await expect(page.getByTestId('meeting-ask')).toHaveCount(0);
  });

  test('the Transcript tab shows every line with a copy button that stays at the top', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1000, height: 500 });
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-tab-transcript').click();
    await expect(page.getByTestId('meeting-tab-transcript')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const lines = page.getByTestId('meeting-transcript').getByTestId('meeting-line');
    await expect(lines).toHaveCount(5);
    await expect(lines.nth(2)).toContainText('Unknown');
    await applyMeeting(page, {
      transcript: Array.from({ length: 60 }, (_, i) => ({
        at: i * 1000,
        speaker: 'you',
        text: `line ${i}`,
      })),
    });
    const copy = page.getByTestId('meeting-transcript-copy');
    const before = (await copy.boundingBox())!.y;
    await page.getByTestId('meeting-transcript').evaluate((el) => {
      (el.parentElement as HTMLElement).scrollTop = 400;
    });
    expect(Math.abs((await copy.boundingBox())!.y - before)).toBeLessThan(2);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await copy.click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.split('\n')[0]).toBe('00:00 You: line 0');
    await expect(copy).toHaveAttribute('title', 'Copied');
  });

  test('numbered voices show as Unknown N, and naming one sends it to the host and relabels it', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await applyMeeting(page, {
      transcript: [
        { at: 9000, speaker: 'them', voice: 1, text: 'voice one speaking' },
        { at: 9500, speaker: 'them', voice: 2, text: 'voice two speaking' },
      ],
    });
    await page.getByTestId('meeting-tab-transcript').click();
    const voices = page.getByTestId('meeting-voice');
    await expect(voices).toHaveText(['Unknown 1', 'Unknown 2']);
    page.once('dialog', (d) => d.accept('Priya'));
    await voices.nth(1).click();
    const reqs = (await sent(page, 'meeting.control_request')) as Array<Record<string, unknown>>;
    expect(reqs.at(-1)).toMatchObject({ action: 'name_voice', voice: 2, name: 'Priya' });
    await applyMeeting(page, { voices: { '2': 'Priya' } });
    await expect(voices).toHaveText(['Unknown 1', 'Priya']);
  });

  test('the settings button opens the switches, prompts, models and timing in place of the tab', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-settings')).toHaveCount(0);
    await page.getByTestId('meeting-cog').click();
    const s = page.getByTestId('meeting-settings');
    await expect(s.getByTestId('meeting-research-on')).toBeChecked();
    await expect(s.getByTestId('meeting-agent-runs')).not.toBeChecked();
    await expect(s).toContainText('Research as we go');
    await expect(s).toContainText('Agent does its own actions');
    await expect(s.getByTestId('meeting-analysis-model')).toBeVisible();
    await expect(s.getByTestId('meeting-analyse-seconds')).toBeVisible();
    await expect(s.getByTestId('meeting-speed')).toBeVisible();
    await expect(page.getByTestId('meeting-points')).toHaveCount(0);
    // each model's label sits above its dropdown, so a narrow panel cannot squeeze it
    const row = s.locator('.set-row', { has: page.getByTestId('meeting-analysis-model') });
    const [label, select] = await Promise.all([
      row.locator('.set-row-title').boundingBox(),
      s.getByTestId('meeting-analysis-model').boundingBox(),
    ]);
    expect(label!.y + label!.height).toBeLessThanOrEqual(select!.y + 1);
    expect(label!.height).toBeLessThan(30);
    await s.getByTestId('meeting-prompt-open-notes').click();
    await expect(s.getByTestId('meeting-prompt-editor')).toBeVisible();
    await page.getByTestId('meeting-tab-notes').click();
    await expect(page.getByTestId('meeting-settings')).toHaveCount(0);
    await expect(page.getByTestId('meeting-points')).toBeVisible();
  });

  test('clicking a point title edits it in place and sends the edit', async ({ page }) => {
    await page.goto(URL_LIVE);
    const failing = page.locator('[data-testid=meeting-topic][data-now=true]');
    const title = failing.getByTestId('meeting-point-title');
    await title.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Sam: the tests fail because the sandbox has no credit');
    await page.keyboard.press('Tab');
    const reqs = (await sent(page, 'meeting.notes_request')) as Array<{ edit: unknown }>;
    expect(reqs.at(-1)!.edit).toMatchObject({
      op: 'set_title',
      text: 'Sam: the tests fail because the sandbox has no credit',
    });
    await expect(failing.getByTestId('meeting-point-title')).toHaveText(
      'Sam: the tests fail because the sandbox has no credit',
    );
  });

  test('editing a decision keeps its Decision: prefix', async ({ page }) => {
    await page.goto(URL_LIVE);
    const t = page.getByTestId('meeting-topic').filter({ hasText: 'release 4.2' });
    await t.getByTestId('meeting-point-title').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Priya: release 4.2 ships on Tuesday');
    await page.keyboard.press('Tab');
    const reqs = (await sent(page, 'meeting.notes_request')) as Array<{ edit: { text: string } }>;
    expect(reqs.at(-1)!.edit.text).toBe('Decision: Priya: release 4.2 ships on Tuesday');
  });

  test('Enter in a bullet starts a new bullet and the caret lands in it', async ({ page }) => {
    await page.goto(URL_LIVE);
    const first = page.getByTestId('meeting-topic').filter({ hasText: 'failing tests' });
    await first.getByTestId('meeting-point-bullet').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    const bullets = first.getByTestId('meeting-point-bullet');
    await expect(bullets).toHaveCount(2);
    await expect(bullets.nth(1)).toBeFocused();
    await page.keyboard.type('A second detail');
    await page.keyboard.press('Tab');
    const edits = (
      (await sent(page, 'meeting.notes_request')) as Array<{ edit: { op: string } }>
    ).map((r) => r.edit.op);
    expect(edits).toContain('add_bullet');
    await expect(bullets.nth(1)).toHaveText('A second detail');
  });

  test('Enter in a title adds its first bullet; an empty bullet left behind is dropped', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const last = page.getByTestId('meeting-topic').filter({ hasText: 'release 4.2' });
    await last.getByTestId('meeting-point-title').click();
    await page.keyboard.press('Enter');
    await expect(last.getByTestId('meeting-point-bullet').first()).toBeFocused();
    await expect(last.getByTestId('meeting-point-bullet')).toHaveCount(2);
    await page.keyboard.press('Enter');
    await expect(last.getByTestId('meeting-point-bullet')).toHaveCount(1);
    await expect(last.getByTestId('meeting-point-bullet').first()).toHaveText('Ships Monday');
  });

  test("clicking a point's time shows the transcript lines it came from, indented under it", async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const newest = page.getByTestId('meeting-topic').filter({ hasText: 'failing tests' });
    await expect(newest.getByTestId('meeting-point-lines')).toHaveCount(0);
    await newest.getByTestId('meeting-point-time').click();
    const lines = newest.getByTestId('meeting-point-line');
    await expect(lines).toHaveCount(3);
    await expect(lines.first()).toContainText('busiest week of the year');
    const [time, line] = await Promise.all([
      newest.getByTestId('meeting-point-time').boundingBox(),
      lines.first().boundingBox(),
    ]);
    // indented under the point, past its time
    expect(line!.x).toBeGreaterThanOrEqual(time!.x + time!.width);
    await newest.getByTestId('meeting-point-time').click();
    await expect(newest.getByTestId('meeting-point-lines')).toHaveCount(0);
  });

  test('the speed option tunes the host', async ({ page }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-cog').click();
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

  test('the Actions tab groups actions by kind, one compact row each', async ({ page }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-actions')).toHaveCount(0);
    await openActions(page);
    await expect(page.getByTestId('meeting-actions').locator('.mm-act-grp')).toHaveText([
      'Mine',
      'Others',
      'Agent',
    ]);
    const rows = page.getByTestId('meeting-action');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-kind', 'mine');
    await expect(rows.nth(1)).toHaveAttribute('data-kind', 'other');
    await expect(rows.nth(2)).toHaveAttribute('data-kind', 'agent');
    for (const r of await rows.all()) expect((await r.boundingBox())!.height).toBeLessThan(44);
  });

  test('an Actions tab with nothing open says so, and has no count', async ({ page }) => {
    await page.goto(URL_LIVE);
    await applyMeeting(page, { actions: [] });
    await expect(page.getByTestId('meeting-tab-actions')).toHaveText('Actions');
    await openActions(page);
    await expect(page.getByTestId('meeting-actions')).toContainText('No actions yet');
  });

  test("Tom's action offers Start chat, not Do it; someone else's offers only an owner and ✕", async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await openActions(page);
    const [mine, other] = [0, 1].map((n) => page.getByTestId('meeting-action').nth(n));
    await expect(mine.getByTestId('meeting-action-chat')).toHaveText('Start chat');
    await expect(mine.getByTestId('meeting-action-do')).toHaveCount(0);
    await expect(other.getByTestId('meeting-action-do')).toHaveCount(0);
    await expect(other.getByTestId('meeting-action-chat')).toHaveCount(0);
    await expect(other.getByTestId('meeting-action-owner')).toHaveValue('Priya');
    await expect(other.getByTestId('meeting-action-dismiss')).toBeVisible();

    await mine.getByTestId('meeting-action-chat').click();
    const reqs = (await sent(page, 'meeting.action_request')) as Array<{
      actionId: string;
      decision: string;
    }>;
    expect(reqs.map((r) => [r.actionId, r.decision])).toEqual([['a1', 'chat']]);
    // The host answers with the new chat: the row now opens it.
    await expect(mine.getByTestId('meeting-action-open')).toHaveText('Open chat');
    await expect(mine.getByTestId('meeting-action-chat')).toHaveCount(0);
  });

  test('the owner dropdown lists the meeting speakers plus Everyone and sends the choice', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await openActions(page);
    const owner = page.getByTestId('meeting-action').nth(1).getByTestId('meeting-action-owner');
    await expect(owner.locator('option')).toHaveText(['Priya', 'Dev', 'Everyone']);
    await owner.selectOption('Everyone');
    const reqs = (await sent(page, 'meeting.action_request')) as Array<Record<string, unknown>>;
    expect(reqs).toEqual([
      { type: 'meeting.action_request', chatId: 'chat_tools', actionId: 'a2', owner: 'Everyone' },
    ]);
    await expect(owner).toHaveValue('Everyone');
  });

  test('agent actions: Run until the switch in settings is on, then status and Open chat', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await openActions(page);
    const agent = page.getByTestId('meeting-action').nth(2);
    await expect(agent.getByTestId('meeting-action-do')).toHaveText('Run');
    await expect(page.getByTestId('meeting-agent-runs')).toHaveCount(0);
    await page.getByTestId('meeting-cog').click();
    const box = page.getByTestId('meeting-agent-runs');
    await expect(box).not.toBeChecked();
    await box.check();
    expect(await sent(page, 'meeting.action_request')).toEqual([
      { type: 'meeting.action_request', chatId: 'chat_tools', agentRuns: true },
    ]);
    await expect(box).toBeChecked();
    await openActions(page);
    // With it on the host starts them itself: simulate its answer.
    await page.evaluate(() => {
      const store = (window as unknown as { __meetingStore: { getState(): any } }).__meetingStore;
      const m = store.getState().byChat['chat_tools'];
      store.getState().apply('chat_tools', {
        ...m,
        actions: m.actions.map((a: any) =>
          a.id === 'a3' ? { ...a, status: 'running', chatId: 'chat_child' } : a,
        ),
      });
    });
    await expect(agent.getByTestId('meeting-action-do')).toHaveCount(0);
    await expect(agent.getByTestId('meeting-action-status')).toBeVisible();
    await expect(agent.getByTestId('meeting-action-open')).toHaveAttribute(
      'href',
      /\/chats\/chat_child$/,
    );
  });

  test('every action can be dismissed', async ({ page }) => {
    await page.goto(URL_LIVE);
    await openActions(page);
    for (const n of [0, 1, 2]) {
      await page
        .getByTestId('meeting-action')
        .first()
        .getByTestId('meeting-action-dismiss')
        .click();
      await expect(page.getByTestId('meeting-action')).toHaveCount(2 - n);
    }
    const reqs = (await sent(page, 'meeting.action_request')) as Array<{ actionId: string }>;
    expect(reqs.map((r) => r.actionId)).toEqual(['a1', 'a2', 'a3']);
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
    await expect(page.getByTestId('meeting-pill')).toHaveText('Paused · 01:00');
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

  test('a host error is one line under the tabs, and shows in full on click', async ({ page }) => {
    await page.goto(URL_LIVE);
    const long = `analysis failed: final analysis returned model commentary: ${'nothing new to process, '.repeat(8)}end`;
    await applyMeeting(page, { error: long });
    const err = page.getByTestId('meeting-error');
    await expect(err).toHaveAttribute('title', long);
    const [e, tabs] = await Promise.all([
      err.boundingBox(),
      page.getByRole('tablist').boundingBox(),
    ]);
    expect(e!.y).toBeGreaterThanOrEqual(tabs!.y + tabs!.height - 1);
    expect(e!.height).toBeLessThan(30);
    await err.click();
    await expect
      .poll(async () => (await err.boundingBox())!.height)
      .toBeGreaterThan(e!.height + 10);
  });
});

test.describe('meeting mode — after', () => {
  const URL_ENDED = '/app/dev-harness.html?chat=chat_tools&meeting=ended';

  test('same header as live: duration pill, people, Resume and a fold button; no Pause or End', async ({
    page,
  }) => {
    await page.goto(URL_ENDED);
    await expect(page.getByTestId('meeting-pill')).toHaveText('52:00');
    await expect(page.getByTestId('meeting-bar')).not.toContainText('Ended');
    await expect(page.getByTestId('meeting-people')).toBeVisible();
    await expect(page.getByTestId('meeting-resume')).toBeVisible();
    await expect(page.getByTestId('meeting-fold')).toBeVisible();
    await expect(page.getByTestId('meeting-pause')).toHaveCount(0);
    await expect(page.getByTestId('meeting-end')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveText([
      'Notes',
      'My notes',
      /^Actions\s*3$/,
      'Transcript',
    ]);
    await expect(page.getByTestId('meeting-tail')).toHaveCount(0);
    await expect(page.locator('[data-testid=meeting-topic][data-now=true]')).toHaveCount(0);
    await expect(page.getByTestId('chat-stream')).toBeVisible();
    await expect(page.getByTestId('composer-input')).toBeEnabled();
    await expect(page.getByTestId('meeting-mode-ask')).toHaveCount(0);
    await expect(page.getByTestId('meeting-card')).toHaveCount(3);
  });

  test('folding puts the meeting into one line over the chat; it stays folded', async ({
    page,
  }) => {
    await page.goto(URL_ENDED);
    await page.getByTestId('meeting-fold').click();
    const bar = page.getByTestId('meeting-bar');
    await expect(bar).toHaveAttribute('data-folded', 'true');
    await expect(page.getByTestId('meeting-panel')).toHaveCount(0);
    await expect(page.getByTestId('chat-stream')).toBeVisible();
    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      'Type a message',
    );
    await expect(page.getByTestId('meeting-pill')).toHaveText('Meeting · 52:00');
    const [b, stream] = await Promise.all([
      bar.boundingBox(),
      page.getByTestId('chat-stream').boundingBox(),
    ]);
    expect(b!.y + b!.height).toBeLessThanOrEqual(stream!.y + 1);
    expect(b!.height).toBeLessThan(60);
    await page.reload();
    await expect(page.getByTestId('meeting-bar')).toHaveAttribute('data-folded', 'true');
    // Transcript opens it again, on the Transcript
    await page.getByTestId('meeting-open-transcript').click();
    await expect(page.getByTestId('meeting-panel')).toBeVisible();
    await expect(page.getByTestId('meeting-tab-transcript')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('chat-stream')).toBeVisible();
  });

  test('a live meeting cannot be folded', async ({ page }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-fold')).toHaveCount(0);
  });

  test('the Actions tab is grouped Agent did / My actions / Other actions, others show the owner name', async ({
    page,
  }) => {
    await page.goto(URL_ENDED);
    await openActions(page);
    await expect(page.getByTestId('meeting-actions').locator('.mm-act-grp')).toHaveText([
      'Agent did',
      'My actions',
      'Other actions',
    ]);
    await expect(page.getByTestId('meeting-action-owner-name')).toHaveText('Priya');
    await expect(page.getByTestId('meeting-action-owner')).toHaveCount(0);
    await expect(page.getByTestId('meeting-action-chat')).toHaveCount(1);
    await expect(page.getByTestId('meeting-action-dismiss')).toHaveCount(1);
  });

  test('the write-up heads Notes: title, date and duration, icon Regenerate and Copy, headings', async ({
    page,
  }) => {
    await page.goto(URL_ENDED);
    await expect(page.getByTestId('meeting-writeup-title')).toHaveText('Bus fund planning call');
    await expect(page.getByTestId('meeting-writeup-meta')).toContainText('52 min');
    for (const id of ['meeting-regenerate', 'meeting-copy']) {
      const b = page.getByTestId(id);
      await expect(b).toBeVisible();
      await expect(b).toHaveText('');
      await expect(b.locator('svg')).toHaveCount(1);
    }
    await expect(page.getByTestId('meeting-writeup-body').locator('h2')).toHaveText([
      'Where we landed',
      'Open questions',
    ]);
    // above every point, with no box of its own
    const [firstPoint, sum] = await Promise.all([
      page.getByTestId('meeting-topic').first().boundingBox(),
      page.getByTestId('meeting-summary').boundingBox(),
    ]);
    expect(sum!.y + sum!.height).toBeLessThanOrEqual(firstPoint!.y + 1);
    expect(
      await page
        .getByTestId('meeting-summary')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe('rgba(0, 0, 0, 0)');
  });

  test("Tom's notes are darker than generated text, and fixed names are underlined with the original", async ({
    page,
  }) => {
    await page.goto(URL_ENDED);
    const li = page.getByTestId('meeting-writeup-body').locator('li');
    const ink = (i: number) => li.nth(i).evaluate((e) => getComputedStyle(e).color);
    expect(await ink(0)).not.toBe(await ink(1));
    const fixed = page.getByTestId('meeting-writeup-body').locator('.fixed');
    await expect(fixed).toHaveText('WECA');
    await expect(fixed).toHaveAttribute('title', 'was: Weka');
    expect(await fixed.evaluate((e) => getComputedStyle(e).borderBottomStyle)).toBe('dotted');
    expect(await fixed.evaluate((e) => getComputedStyle(e).position)).toBe('static');
  });
  test("editing the write-up saves it, and an edited line becomes Tom's", async ({ page }) => {
    await page.goto(URL_ENDED);
    await page.getByTestId('meeting-writeup-title').fill('Renamed call');
    await page.getByTestId('meeting-writeup-body').locator('li').nth(1).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' by March');
    await page.getByTestId('meeting-writeup-title').click();
    await expect
      .poll(async () => (await sent(page, 'meeting.writeup_request')).length)
      .toBeGreaterThan(0);
    const last = (await sent(page, 'meeting.writeup_request')).at(-1) as unknown as {
      writeup: { title: string; sections: { items: { text: string; mine?: boolean }[] }[] };
    };
    expect(last.writeup.title).toBe('Renamed call');
    expect(last.writeup.sections[0]!.items[1]).toEqual({
      text: 'Main lever is the capital pipeline, set in the next year by March',
      mine: true,
    });
    expect(last.writeup.sections[1]!.items[0]).toEqual({
      text: 'How the forum sits alongside the bus users group',
    });
  });

  test('Regenerate asks the host to write it again and waits for the answer', async ({ page }) => {
    await page.goto(URL_ENDED);
    await page.getByTestId('meeting-regenerate').click();
    expect(await sent(page, 'meeting.writeup_request')).toMatchObject([
      { chatId: 'chat_tools', regenerate: true },
    ]);
    await expect(page.getByTestId('meeting-regenerate')).toHaveAttribute('title', 'Writing…');
    await expect(page.getByTestId('meeting-regenerate')).toBeDisabled();
    await page.evaluate(() => {
      const store = (window as unknown as { __meetingStore: any }).__meetingStore;
      const m = store.getState().byChat['chat_tools'];
      store.getState().apply('chat_tools', { ...m, writeup: { title: 'Second go', sections: [] } });
    });
    await expect(page.getByTestId('meeting-regenerate')).toHaveAttribute('title', 'Regenerate');
    await expect(page.getByTestId('meeting-writeup-title')).toHaveText('Second go');
  });
  test('a failed write-up says so, and a missing one says it is being written', async ({
    page,
  }) => {
    await page.goto(URL_ENDED);
    await page.evaluate(() => {
      const store = (window as unknown as { __meetingStore: any }).__meetingStore;
      const m = store.getState().byChat['chat_tools'];
      store.getState().apply('chat_tools', { ...m, writeup: null });
    });
    await expect(page.getByTestId('meeting-writeup-wait')).toBeVisible();
    await page.evaluate(() => {
      const store = (window as unknown as { __meetingStore: any }).__meetingStore;
      const m = store.getState().byChat['chat_tools'];
      store.getState().apply('chat_tools', { ...m, writeupError: 'write-up failed: model down' });
    });
    await expect(page.getByTestId('meeting-writeup-error')).toContainText('model down');
    await expect(page.getByTestId('meeting-writeup-wait')).toHaveCount(0);
  });

  test('a meeting that just ended goes to Notes, headed by the write-up being written', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-tab-transcript').click();
    await applyMeeting(page, { status: 'ended', writeup: null });
    await expect(page.getByTestId('meeting-tab-notes')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('meeting-writeup-wait')).toBeVisible();
  });

  test('Resume starts listening again and asks the host to resume', async ({ page }) => {
    await page.goto(URL_ENDED);
    await page.getByTestId('meeting-resume').click();
    await expect
      .poll(async () => (await sent(page, 'meeting.control_request')).length)
      .toBeGreaterThan(0);
    expect((await sent(page, 'meeting.control_request')).at(-1)).toMatchObject({
      action: 'resume',
    });
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
    await expect(page.getByTestId('meeting-points')).toContainText('Listening');
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
  test('the cog opens the prompts, and Save writes it without leaving the meeting', async ({
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
    await page.getByTestId('meeting-cog').click();
    await page.getByTestId('meeting-prompt-open-now').click();
    const box = page.getByTestId('meeting-prompt-text');
    await expect(box).toContainText('headline');
    await box.fill('Only a headline.');
    await page.getByTestId('meeting-prompt-save').click();
    await expect(page.getByTestId('meeting-prompt-editor')).toHaveCount(0);
    expect(writes).toEqual([{ meetingNowPrompt: 'Only a headline.' }]);
    // still on the meeting page, still live
    await expect(page.getByTestId('meeting-panel')).toBeVisible();
    // the cog reaches the other two via tabs
    await page.getByTestId('meeting-prompt-open-actions').click();
    await expect(page.getByTestId('meeting-prompt-text')).toContainText('"actions"');
    await page.getByTestId('meeting-prompt-reset').click();
    await expect(page.getByTestId('meeting-prompt-editor')).toHaveCount(0);
    expect(writes).toHaveLength(2);
    expect(Object.keys(writes[1]!)).toEqual(['meetingActionsPrompt']);
  });
});

test.describe('meeting mode — research cards', () => {
  test('show the three card types by a coloured label, with title, time, bullets and no left bar', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const cards = page.getByTestId('meeting-card');
    await expect(cards).toHaveCount(3);
    // oldest first, among the points in Notes
    await expect(cards.nth(0).getByTestId('meeting-card-kind')).toHaveText('Answer');
    await expect(cards.nth(1).getByTestId('meeting-card-kind')).toHaveText('Fact check');
    await expect(cards.nth(2).getByTestId('meeting-card-title')).toHaveText('Harbour levy');
    await expect(cards.nth(2).getByTestId('meeting-card-kind')).toHaveText('Explained');
    await expect(cards.nth(2)).toContainText('24:46');
    const colours = await cards.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el.querySelector('[data-testid=meeting-card-kind]')!).color),
    );
    expect(new Set(colours).size).toBe(3);
    for (const c of await cards.all()) {
      expect(await c.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('1px');
      const n = await c.locator('li').count();
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(3);
    }
  });

  test('a fact check carries its quoted claim, a verdict chip and a source link', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const fact = page.locator('[data-testid=meeting-card][data-kind=fact]');
    await expect(fact.getByTestId('meeting-card-title')).toHaveText(
      '"The ferry carries about fifty cars"',
    );
    await expect(fact.getByTestId('meeting-card-verdict')).toHaveText('Off');
    const link = fact.getByTestId('meeting-card-source');
    await expect(link).toHaveText('Operator fleet page');
    await expect(link).toHaveAttribute('href', 'https://example.org/fleet');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(page.getByTestId('meeting-card-verdict')).toHaveCount(1);
  });

  test('the research switch tells the host, and a failed pass shows under the tabs', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-cog').click();
    await page.getByTestId('meeting-research-on').uncheck();
    await expect.poll(async () => (await sent(page, 'meeting.research_request')).length).toBe(1);
    expect((await sent(page, 'meeting.research_request'))[0]).toMatchObject({ on: false });
    await page.getByTestId('meeting-tab-notes').click();
    await expect(page.getByTestId('meeting-research-error')).toHaveCount(0);
    await applyMeeting(page, { researchError: 'research failed: search is down' });
    const err = page.getByTestId('meeting-research-error');
    await expect(err).toHaveText('research failed: search is down');
    const [e, tabs] = await Promise.all([
      err.boundingBox(),
      page.getByRole('tablist').boundingBox(),
    ]);
    expect(e!.y).toBeGreaterThanOrEqual(tabs!.y + tabs!.height - 1);
  });

  test('a reply in the chat that changed the notes carries a chip, and only that reply', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const t0 = await page.evaluate(() => {
      const chats = (window as unknown as { __chatStore: any }).__chatStore;
      const m = (window as unknown as { __meetingStore: any }).__meetingStore.getState().byChat[
        'chat_tools'
      ];
      const at = m.startedAt + 30 * 60_000;
      chats.setState((st: any) => ({
        timelines: {
          ...st.timelines,
          chat_tools: [
            ...st.timelines.chat_tools,
            { seq: 900, kind: 'message', role: 'assistant', content: 'Added it.', messageAt: at },
            {
              seq: 901,
              kind: 'message',
              role: 'assistant',
              content: 'Anything else?',
              messageAt: at + 60_000,
            },
          ],
        },
      }));
      return at;
    });
    await expect(page.getByTestId('meeting-edit-chip')).toHaveCount(0);
    await applyMeeting(page, {
      agentEdits: [{ id: 'e1', at: t0 - 1000, label: 'Added to points' }],
    });
    // the answers are chat messages, in the chat
    const answers = page.getByTestId('chat-stream').getByTestId('msg');
    await expect(
      answers.filter({ hasText: 'Added it.' }).getByTestId('meeting-edit-chip'),
    ).toHaveText('✓ Added to points');
    await expect(
      answers.filter({ hasText: 'Anything else?' }).getByTestId('meeting-edit-chip'),
    ).toHaveCount(0);
  });

  test('an ended meeting keeps its cards; research is locked and the agent switch is gone', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_tools&meeting=ended');
    await expect(page.getByTestId('meeting-card')).toHaveCount(3);
    await page.getByTestId('meeting-cog').click();
    await expect(page.getByTestId('meeting-research-on')).toBeDisabled();
    await expect(page.getByTestId('meeting-agent-runs')).toHaveCount(0);
  });

  test('the settings hold the research model and the least gap between passes', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-cog').click();
    await expect(page.getByTestId('meeting-research-model')).toBeVisible();
    await expect(page.getByTestId('meeting-research-seconds')).toHaveValue('60');
  });
});
