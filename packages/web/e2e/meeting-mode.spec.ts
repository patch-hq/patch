import { test, expect, type Page } from '@playwright/test';

// Meeting mode (components/MeetingPanel.tsx, design/meeting-feed). The harness has no host, so the
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

/** Opens a folded topic in the feed by a piece of its summary. */
const openTopic = (page: Page, text: string) =>
  page
    .getByTestId('meeting-topic')
    .filter({ hasText: text })
    .getByTestId('meeting-topic-toggle')
    .click();

test.describe('meeting mode — live', () => {
  test('the meeting sits across the top of the chat, full width, over the messages and composer', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const panel = page.getByTestId('meeting-panel');
    await expect(panel).toBeVisible();
    const [stream, composer, pan, body, bar] = await Promise.all([
      page.getByTestId('chat-stream').boundingBox(),
      page.getByTestId('composer').boundingBox(),
      panel.boundingBox(),
      page.getByTestId('meeting-body').boundingBox(),
      page.getByTestId('meeting-resize').boundingBox(),
    ]);
    expect(Math.abs(pan!.x - body!.x)).toBeLessThan(1);
    expect(Math.abs(pan!.width - body!.width)).toBeLessThan(1);
    expect(bar!.y).toBeGreaterThanOrEqual(pan!.y + pan!.height - 1);
    expect(stream!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
    expect(composer!.y).toBeGreaterThan(stream!.y);
    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      'Ask about the meeting…',
    );
  });

  test('dragging the bar shares the height between the meeting and the chat, and is remembered', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const panel = page.getByTestId('meeting-panel');
    const bar = page.getByTestId('meeting-resize');
    const before = (await panel.boundingBox())!.height;
    const b = (await bar.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y - 150, { steps: 5 });
    await page.mouse.up();
    const after = (await panel.boundingBox())!.height;
    expect(after).toBeLessThan(before - 100);
    await page.reload();
    await expect
      .poll(async () => (await page.getByTestId('meeting-panel').boundingBox())!.height)
      .toBeLessThan(before - 100);
    // the keyboard moves it too
    await page.getByTestId('meeting-resize').focus();
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(async () => (await page.getByTestId('meeting-panel').boundingBox())!.height)
      .toBeGreaterThan(after + 10);
  });

  test('one header row: Notes and Transcript icons, people, timer, Pause, End, settings', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const ids = [
      'meeting-view-notes',
      'meeting-view-transcript',
      'meeting-people',
      'meeting-pill',
      'meeting-pause',
      'meeting-end',
      'meeting-cog',
    ];
    const boxes = await Promise.all(ids.map((id) => page.getByTestId(id).boundingBox()));
    const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
    for (const b of boxes) expect(Math.abs(mid(b!) - mid(boxes[0]!))).toBeLessThan(4);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x);
    // icons, not words
    for (const id of ['meeting-pause', 'meeting-end', 'meeting-view-notes']) {
      await expect(page.getByTestId(id)).toHaveText('');
      await expect(page.getByTestId(id).locator('svg')).toHaveCount(1);
    }
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByTestId('meeting-view-notes')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('meeting-pill')).toHaveText(/^3\d:\d\d$/);
    await expect(page.getByTestId('meeting-pill').locator('.mm-dot')).toBeVisible();
  });

  test('at 390px the meeting still sits on top with no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(URL_LIVE);
    const overflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(await overflow()).toBe(false);
    const [stream, pan] = await Promise.all([
      page.getByTestId('chat-stream').boundingBox(),
      page.getByTestId('meeting-panel').boundingBox(),
    ]);
    expect(stream!.y).toBeGreaterThanOrEqual(pan!.y + pan!.height - 1);
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
  });

  test('the feed runs oldest first: topics with how long each ran, the newest open, the rest folded', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const topics = page.getByTestId('meeting-topic');
    await expect(topics).toHaveCount(3);
    await expect(topics.getByTestId('meeting-point-time')).toHaveText([
      '00:30–22:05 · 22 min',
      '22:05–31:40 · 10 min',
      /^31:40–3\d:\d\d · \d min$/,
    ]);
    await expect(topics.nth(0)).not.toHaveAttribute('data-open', 'true');
    await expect(topics.nth(1)).not.toHaveAttribute('data-open', 'true');
    await expect(topics.nth(2)).toHaveAttribute('data-open', 'true');
    await expect(topics.nth(2)).toContainText('Sandbox out of credit');
    await expect(topics.nth(0)).not.toContainText('Ships Monday');
    await expect(topics.locator('.decw')).toHaveText(['Decided', 'Decided']);
    // opening a folded topic shows its detail and what came up in it
    await openTopic(page, 'release 4.2');
    await expect(topics.nth(0)).toContainText('Ships Monday');
    await expect(topics.nth(0).getByTestId('meeting-card')).toHaveCount(1);
    await expect(topics.nth(0).getByTestId('meeting-note')).toContainText(
      'ask Marco about the sandbox budget',
    );
    await expect(topics.nth(0).getByTestId('meeting-feed-action')).toContainText(
      'Find dates for the vendor review',
    );
    // and the newest folds away when asked
    await topics.nth(2).getByTestId('meeting-topic-toggle').click();
    await expect(topics.nth(2)).not.toHaveAttribute('data-open', 'true');
  });

  test('actions and then what was just said close the feed, in the same scroll', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const feed = page.getByTestId('meeting-points');
    const [lastTopic, actions, said] = await Promise.all([
      page.getByTestId('meeting-topic').last().boundingBox(),
      feed.getByTestId('meeting-actions').boundingBox(),
      feed.getByTestId('meeting-tail').boundingBox(),
    ]);
    expect(actions!.y).toBeGreaterThan(lastTopic!.y);
    expect(said!.y).toBeGreaterThan(actions!.y);
    const lines = feed.getByTestId('meeting-tail').getByTestId('meeting-line');
    // at least the last four lines, labelled by speaker
    await expect(lines).toHaveCount(4);
    await expect(lines.nth(1)).toContainText('Unknown');
    await expect(lines.nth(1)).not.toContainText('Them');
    await expect(lines.nth(2)).toContainText('Unknown 2');
    await expect(lines.last()).toContainText('statement run');
  });

  test('the feed stays pinned to the newest until Tom scrolls up', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(URL_LIVE);
    const scroller = page.getByTestId('meeting-points');
    const gap = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await expect.poll(gap).toBeLessThan(5);
    const add = (n: number) =>
      page.evaluate((k) => {
        const store = (window as unknown as { __meetingStore: any }).__meetingStore;
        const cur = store.getState().byChat['chat_tools'];
        const extra = Array.from({ length: 6 }, (_, i) => ({
          at: 34 * 60_000 + k * 10_000 + i * 1000,
          speaker: 'you',
          text: `more talk ${k}.${i}`,
        }));
        store.getState().apply('chat_tools', { ...cur, transcript: [...cur.transcript, ...extra] });
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

  test("Tom's notes sit in the feed in full ink; Add note writes a timed note and the chat gets nothing", async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-note-add').click();
    const box = page.getByTestId('meeting-note-add-input');
    await box.fill('chase the vendor dates');
    await box.press('Enter');
    const req = (await sent(page, 'meeting.my_notes_request')).at(-1) as unknown as {
      chatId: string;
      text: string;
    };
    expect(req.chatId).toBe('chat_tools');
    expect(req.text).toMatch(
      /^01:40 ask Marco about the sandbox budget\n22:30 check the flag plan with Priya\n3\d:\d\d chase the vendor dates$/,
    );
    expect(await sent(page, 'chat.input')).toHaveLength(0);
    const newest = page.getByTestId('meeting-topic').last();
    await expect(newest.getByTestId('meeting-note')).toContainText('chase the vendor dates');
    const ink = await page.evaluate(() => {
      const d = document.createElement('div');
      d.style.color = 'var(--ink)';
      document.body.appendChild(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    });
    expect(
      await newest.getByTestId('meeting-note-text').evaluate((el) => getComputedStyle(el).color),
    ).toBe(ink);
  });

  test('a note is edited in place, and emptying it removes it', async ({ page }) => {
    await page.goto(URL_LIVE);
    await openTopic(page, 'release 4.2');
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

  test('the Transcript icon shows every line with a copy button that stays at the top', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-view-transcript').click();
    await expect(page.getByTestId('meeting-view-transcript')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('meeting-points')).toHaveCount(0);
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
    await page.getByTestId('meeting-view-notes').click();
    await expect(page.getByTestId('meeting-points')).toBeVisible();
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
    await page.getByTestId('meeting-view-transcript').click();
    const voices = page.getByTestId('meeting-voice');
    await expect(voices).toHaveText(['Unknown 1', 'Unknown 2']);
    page.once('dialog', (d) => d.accept('Priya'));
    await voices.nth(1).click();
    const reqs = (await sent(page, 'meeting.control_request')) as Array<Record<string, unknown>>;
    expect(reqs.at(-1)).toMatchObject({ action: 'name_voice', voice: 2, name: 'Priya' });
    await applyMeeting(page, { voices: { '2': 'Priya' } });
    await expect(voices).toHaveText(['Unknown 1', 'Priya']);
  });

  test('settings: the research switch, speed, models, and every prompt, in place of the feed', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-settings')).toHaveCount(0);
    await page.getByTestId('meeting-cog').click();
    const s = page.getByTestId('meeting-settings');
    await expect(s.getByTestId('meeting-research-on')).toBeChecked();
    await expect(s).toContainText('Agent researches during call');
    await expect(s.getByTestId('meeting-agent-runs')).toHaveCount(0);
    await expect(s).not.toContainText('Agent does its own actions');
    await expect(s.getByTestId('meeting-analysis-model')).toBeVisible();
    await expect(s.getByTestId('meeting-analyse-seconds')).toBeVisible();
    await expect(s.getByTestId('meeting-speed')).toBeVisible();
    await expect(page.getByTestId('meeting-points')).toHaveCount(0);
    await expect(
      s.getByTestId('meeting-prompts').locator('.mm-prompt-h > span:first-child'),
    ).toHaveText([
      'Now',
      'Notes',
      'Actions',
      'Notes pass (around the three above)',
      'Transcript clean-up',
      'Research',
      'Write-up',
    ]);
    // a fixed prompt opens to read, with no way to edit it
    await s.getByTestId('meeting-prompt-research').locator('.mm-prompt-h').click();
    await expect(s.getByTestId('meeting-prompt-research')).toContainText('research aide');
    await expect(s.getByTestId('meeting-prompt-research').locator('textarea')).toHaveCount(0);
    await page.getByTestId('meeting-view-notes').click();
    await expect(page.getByTestId('meeting-settings')).toHaveCount(0);
    await expect(page.getByTestId('meeting-points')).toBeVisible();
  });

  test('clicking a topic summary edits it in place and sends the edit', async ({ page }) => {
    await page.goto(URL_LIVE);
    const newest = page.getByTestId('meeting-topic').last();
    await newest.getByTestId('meeting-point-title').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Sam: the tests fail because the sandbox has no credit');
    await page.keyboard.press('Tab');
    const reqs = (await sent(page, 'meeting.notes_request')) as Array<{ edit: unknown }>;
    expect(reqs.at(-1)!.edit).toMatchObject({
      op: 'set_title',
      text: 'Sam: the tests fail because the sandbox has no credit',
    });
    await expect(newest.getByTestId('meeting-point-title')).toHaveText(
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
    const newest = page.getByTestId('meeting-topic').last();
    await newest.getByTestId('meeting-point-bullet').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    const bullets = newest.getByTestId('meeting-point-bullet');
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

  test('Enter in a summary adds its first bullet; an empty bullet left behind is dropped', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await openTopic(page, 'release 4.2');
    const t = page.getByTestId('meeting-topic').filter({ hasText: 'release 4.2' });
    await t.getByTestId('meeting-point-title').click();
    await page.keyboard.press('Enter');
    await expect(t.getByTestId('meeting-point-bullet').first()).toBeFocused();
    await expect(t.getByTestId('meeting-point-bullet')).toHaveCount(2);
    await page.keyboard.press('Enter');
    await expect(t.getByTestId('meeting-point-bullet')).toHaveCount(1);
    await expect(t.getByTestId('meeting-point-bullet').first()).toHaveText('Ships Monday');
  });

  test("clicking a topic's time shows the transcript lines it came from, under it", async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const newest = page.getByTestId('meeting-topic').last();
    await expect(newest.getByTestId('meeting-point-lines')).toHaveCount(0);
    await newest.getByTestId('meeting-point-time').click();
    const lines = newest.getByTestId('meeting-point-line');
    await expect(lines).toHaveCount(3);
    await expect(lines.first()).toContainText('busiest week of the year');
    await newest.getByTestId('meeting-point-time').click();
    await expect(newest.getByTestId('meeting-point-lines')).toHaveCount(0);
    // on a folded topic it opens the topic with its lines
    const first = page.getByTestId('meeting-topic').first();
    await first.getByTestId('meeting-point-time').click();
    await expect(first).toHaveAttribute('data-open', 'true');
    await expect(first.getByTestId('meeting-point-lines')).toHaveText(
      'No transcript for this topic',
    );
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

  test('an action expands to show where it came from, and folds again', async ({ page }) => {
    await page.goto(URL_LIVE);
    await applyMeeting(page, {
      transcript: [
        {
          at: 22 * 60_000 + 3000,
          speaker: 'them',
          name: 'Priya',
          text: 'I can send the Q3 retention deck over.',
        },
      ],
    });
    const row = page.getByTestId('meeting-actions').getByTestId('meeting-action-wrap').nth(1);
    await expect(row.getByTestId('meeting-action-source')).toHaveCount(0);
    await row.getByTestId('meeting-action-toggle').click();
    const src = row.getByTestId('meeting-action-source');
    await expect(src).toBeVisible();
    await expect(src.getByTestId('meeting-action-when')).toContainText(':');
    await expect(src.getByTestId('meeting-action-excerpt')).toContainText('retention deck');
    await expect(src.getByTestId('meeting-action-when')).toContainText('Priya');
    await row.getByTestId('meeting-action-toggle').click();
    await expect(src).toHaveCount(0);
  });

  test('actions are one line each, oldest first: tick, who, what, and Approve for the agent', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const rows = page.getByTestId('meeting-actions').getByTestId('meeting-action');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-kind', 'agent');
    await expect(rows.nth(1)).toHaveAttribute('data-kind', 'other');
    await expect(rows.nth(2)).toHaveAttribute('data-kind', 'mine');
    for (const r of await rows.all()) expect((await r.boundingBox())!.height).toBeLessThan(36);
    await expect(rows.nth(0).getByTestId('meeting-action-do')).toHaveText('Approve');
    await expect(rows.nth(1).getByTestId('meeting-action-do')).toHaveCount(0);
    await expect(rows.nth(2).getByTestId('meeting-action-chat')).toHaveText('Start chat');
    await rows.nth(0).getByTestId('meeting-action-do').click();
    expect(await sent(page, 'meeting.action_request')).toEqual([
      { type: 'meeting.action_request', chatId: 'chat_tools', actionId: 'a3', decision: 'do' },
    ]);
    // the host starts it in a linked chat: status and Open chat replace Approve
    await expect(rows.nth(0).getByTestId('meeting-action-do')).toHaveCount(0);
    await expect(rows.nth(0).getByTestId('meeting-action-status')).toBeVisible();
    await expect(rows.nth(0).getByTestId('meeting-action-open')).toHaveAttribute(
      'href',
      /\/chats\/chat_child$/,
    );
  });

  test('the owner can be anyone: You, Agent, the people on the call, or Everyone', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const owner = page.getByTestId('meeting-action').nth(1).getByTestId('meeting-action-owner');
    await expect(owner.locator('option')).toHaveText(['You', 'Agent', 'Priya', 'Dev', 'Everyone']);
    await expect(owner).toHaveValue('other:Priya');
    await owner.selectOption('agent');
    await owner.selectOption({ label: 'Everyone' });
    expect(await sent(page, 'meeting.action_request')).toEqual([
      {
        type: 'meeting.action_request',
        chatId: 'chat_tools',
        actionId: 'a2',
        assign: { kind: 'agent' },
      },
      {
        type: 'meeting.action_request',
        chatId: 'chat_tools',
        actionId: 'a2',
        assign: { kind: 'other', owner: 'Everyone' },
      },
    ]);
    await expect(owner).toHaveValue('other:Everyone');
  });

  test('an action is edited in place, ticked off and back, and new ones are added', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const rows = page.getByTestId('meeting-action');
    await rows.nth(2).getByTestId('meeting-action-title').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Top up the sandbox by £100');
    await page.keyboard.press('Enter');
    await rows.nth(2).getByTestId('meeting-action-done').check();
    await expect(rows.nth(2)).toHaveAttribute('data-status', 'done');
    await rows.nth(2).getByTestId('meeting-action-done').uncheck();
    await expect(rows.nth(2)).toHaveAttribute('data-status', 'pending');
    await page.getByTestId('meeting-action-add').click();
    await page.getByTestId('meeting-action-add-input').fill('Book the follow-up');
    await page.keyboard.press('Enter');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(3)).toContainText('Book the follow-up');
    const reqs = (await sent(page, 'meeting.action_request')) as Array<Record<string, unknown>>;
    expect(reqs.map(({ type: _t, chatId: _c, ...r }) => r)).toEqual([
      { actionId: 'a1', title: 'Top up the sandbox by £100' },
      { actionId: 'a1', decision: 'done' },
      { actionId: 'a1', decision: 'reopen' },
      { add: { title: 'Book the follow-up', kind: 'mine' } },
    ]);
  });

  test('every action can be dismissed', async ({ page }) => {
    await page.goto(URL_LIVE);
    const rows = page.getByTestId('meeting-action');
    for (const n of [0, 1, 2]) {
      await rows.first().getByTestId('meeting-action-dismiss').click();
      await expect(rows).toHaveCount(2 - n);
    }
    const reqs = (await sent(page, 'meeting.action_request')) as Array<{ actionId: string }>;
    expect(reqs.map((r) => r.actionId)).toEqual(['a3', 'a2', 'a1']);
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

  test('a host error is one line under the header, and shows in full on click', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const long = `analysis failed: final analysis returned model commentary: ${'nothing new to process, '.repeat(8)}end`;
    await applyMeeting(page, { error: long });
    const err = page.getByTestId('meeting-error');
    await expect(err).toHaveAttribute('title', long);
    const [e, head] = await Promise.all([
      err.boundingBox(),
      page.getByTestId('meeting-panel').getByTestId('meeting-bar').boundingBox(),
    ]);
    expect(e!.y).toBeGreaterThanOrEqual(head!.y + head!.height - 1);
    expect(e!.height).toBeLessThan(30);
    await err.click();
    await expect
      .poll(async () => (await err.boundingBox())!.height)
      .toBeGreaterThan(e!.height + 10);
  });
});

test.describe('meeting mode — after', () => {
  const URL_ENDED = '/app/dev-harness.html?chat=chat_tools&meeting=ended';

  test('same header as live: duration, people, Resume, copy and fold; no Pause or End', async ({
    page,
  }) => {
    await page.goto(URL_ENDED);
    await expect(page.getByTestId('meeting-pill')).toHaveText('52:00');
    await expect(page.getByTestId('meeting-people')).toBeVisible();
    for (const id of ['meeting-resume', 'meeting-copy', 'meeting-fold'])
      await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId('meeting-pause')).toHaveCount(0);
    await expect(page.getByTestId('meeting-end')).toHaveCount(0);
    await expect(page.getByTestId('meeting-regenerate')).toHaveCount(0);
    await expect(page.getByTestId('meeting-tail')).toHaveCount(0);
    await expect(page.getByTestId('meeting-note-add')).toHaveCount(0);
    await expect(page.getByTestId('chat-stream')).toBeVisible();
    await expect(page.getByTestId('composer-input')).toBeEnabled();
  });

  test('everything folds to its one-line summary; the write-up heads them, folded too', async ({
    page,
  }) => {
    await page.goto(URL_ENDED);
    const topics = page.getByTestId('meeting-topic');
    await expect(topics).toHaveCount(3);
    for (const t of await topics.all()) await expect(t).not.toHaveAttribute('data-open', 'true');
    const [sum, first] = await Promise.all([
      page.getByTestId('meeting-summary').boundingBox(),
      topics.first().boundingBox(),
    ]);
    expect(sum!.y + sum!.height).toBeLessThanOrEqual(first!.y + 1);
    await expect(page.getByTestId('meeting-writeup-body')).toHaveCount(0);
    await page.getByTestId('meeting-writeup-toggle').click();
    await expect(page.getByTestId('meeting-writeup-body').locator('h2')).toHaveText([
      'Where we landed',
      'Open questions',
    ]);
    // the last topic runs to the end of the meeting
    await expect(topics.last().getByTestId('meeting-point-time')).toHaveText(
      '31:40–52:00 · 20 min',
    );
    // actions stay, and can still be dealt with
    await expect(page.getByTestId('meeting-action')).toHaveCount(3);
    await expect(page.getByTestId('meeting-action-dismiss')).toHaveCount(3);
  });

  test('Copy puts the write-up on the clipboard', async ({ page }) => {
    await page.goto(URL_ENDED);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByTestId('meeting-copy').click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('Bus fund planning call');
    expect(text).toContain('Where we landed');
    await expect(page.getByTestId('meeting-copy')).toHaveAttribute('title', 'Copied');
  });

  test('folding puts the meeting into one line over the chat; it stays folded', async ({
    page,
  }) => {
    await page.goto(URL_ENDED);
    await page.getByTestId('meeting-fold').click();
    const bar = page.getByTestId('meeting-bar');
    await expect(bar).toHaveAttribute('data-folded', 'true');
    await expect(page.getByTestId('meeting-panel')).toHaveCount(0);
    await expect(page.getByTestId('meeting-resize')).toHaveCount(0);
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
    // Transcript opens it again, on the transcript
    await page.getByTestId('meeting-open-transcript').click();
    await expect(page.getByTestId('meeting-panel')).toBeVisible();
    await expect(page.getByTestId('meeting-view-transcript')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('a live meeting cannot be folded', async ({ page }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-fold')).toHaveCount(0);
  });

  test("Tom's words are darker than generated text, and fixed names are underlined with the original", async ({
    page,
  }) => {
    await page.goto(URL_ENDED);
    await page.getByTestId('meeting-writeup-toggle').click();
    const li = page.getByTestId('meeting-writeup-body').locator('li');
    const ink = (i: number) => li.nth(i).evaluate((e) => getComputedStyle(e).color);
    expect(await ink(0)).not.toBe(await ink(1));
    const fixed = page.getByTestId('meeting-writeup-body').locator('.name-fixed');
    await expect(fixed).toHaveText('WECA');
    await expect(fixed).toHaveAttribute('title', 'was: Weka');
    expect(await fixed.evaluate((e) => getComputedStyle(e).borderBottomStyle)).toBe('dotted');
    expect(await fixed.evaluate((e) => getComputedStyle(e).position)).toBe('static');
  });

  test("editing the write-up saves it, and an edited line becomes Tom's", async ({ page }) => {
    await page.goto(URL_ENDED);
    await page.getByTestId('meeting-writeup-toggle').click();
    await page.getByTestId('meeting-writeup-body').locator('li').nth(1).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' by March');
    await page.getByTestId('meeting-people').click();
    await expect
      .poll(async () => (await sent(page, 'meeting.writeup_request')).length)
      .toBeGreaterThan(0);
    const last = (await sent(page, 'meeting.writeup_request')).at(-1) as unknown as {
      writeup: { title: string; sections: { items: { text: string; mine?: boolean }[] }[] };
    };
    expect(last.writeup.title).toBe('Bus fund planning call');
    expect(last.writeup.sections[0]!.items[1]).toEqual({
      text: 'Main lever is the capital pipeline, set in the next year by March',
      mine: true,
    });
  });

  test('a failed write-up says so, and a missing one says it is being written', async ({
    page,
  }) => {
    await page.goto(URL_ENDED);
    await applyMeeting(page, { writeup: null });
    await expect(page.getByTestId('meeting-writeup-wait')).toBeVisible();
    await expect(page.getByTestId('meeting-copy')).toHaveCount(0);
    await applyMeeting(page, { writeupError: 'write-up failed: model down' });
    await expect(page.getByTestId('meeting-writeup-error')).toContainText('model down');
    await expect(page.getByTestId('meeting-writeup-wait')).toHaveCount(0);
  });

  test('a meeting that just ended goes to the feed, headed by the write-up being written', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-view-transcript').click();
    await applyMeeting(page, { status: 'ended', writeup: null });
    await expect(page.getByTestId('meeting-view-notes')).toHaveAttribute('aria-pressed', 'true');
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
  test('settings open a prompt in place, and Save and Reset write it without leaving the meeting', async ({
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
    await page.getByTestId('meeting-cog').click();
    await expect(page.getByTestId('meeting-prompt-text')).toHaveCount(0);
    await page.getByTestId('meeting-prompt-open-now').click();
    const box = page.getByTestId('meeting-prompt-text');
    await expect(box).toHaveValue(/headline/);
    await box.fill('Only a headline.');
    await page.getByTestId('meeting-prompt-save').click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes).toEqual([{ meetingNowPrompt: 'Only a headline.' }]);
    await expect(page.getByTestId('meeting-panel')).toBeVisible();
    await page.getByTestId('meeting-prompt-open-now').click();
    await page.getByTestId('meeting-prompt-open-actions').click();
    await expect(page.getByTestId('meeting-prompt-text')).toHaveValue(/"actions"/);
    await page.getByTestId('meeting-prompt-reset').click();
    await expect.poll(() => writes.length).toBe(2);
    expect(Object.keys(writes[1]!)).toEqual(['meetingActionsPrompt']);
  });
});

test.describe('meeting mode — research cards', () => {
  test('one line each, the type by the chip colour, opening to bullets and source', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await openTopic(page, 'release 4.2');
    await openTopic(page, 'points ledger');
    const cards = page.getByTestId('meeting-card');
    await expect(cards).toHaveCount(3);
    await expect(cards.getByTestId('meeting-card-kind')).toHaveText([
      'Answer',
      'Fact check',
      'Explained',
    ]);
    await expect(cards.nth(2).getByTestId('meeting-card-title')).toHaveText('Harbour levy');
    const colours = await cards.evaluateAll((els) =>
      els.map(
        (el) =>
          getComputedStyle(el.querySelector('[data-testid=meeting-card-kind]')!).backgroundColor,
      ),
    );
    expect(new Set(colours).size).toBe(3);
    for (const c of await cards.all()) {
      expect((await c.boundingBox())!.height).toBeLessThan(30);
      expect(await c.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('0px');
    }
    const fact = page.locator('[data-testid=meeting-card][data-kind=fact]');
    await expect(fact.getByTestId('meeting-card-title')).toHaveText(
      '"The ferry carries about fifty cars"',
    );
    await expect(fact.getByTestId('meeting-card-verdict')).toHaveText('Off');
    await fact.locator('.mm-card-h').click();
    await expect(fact.locator('li')).toHaveText(['The operator lists a deck capacity of 40 cars']);
    const link = fact.getByTestId('meeting-card-source');
    await expect(link).toHaveText('Operator fleet page');
    await expect(link).toHaveAttribute('href', 'https://example.org/fleet');
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('the research switch tells the host, and a failed pass shows under the header', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-cog').click();
    await page.getByTestId('meeting-research-on').uncheck();
    await expect.poll(async () => (await sent(page, 'meeting.research_request')).length).toBe(1);
    expect((await sent(page, 'meeting.research_request'))[0]).toMatchObject({ on: false });
    await page.getByTestId('meeting-view-notes').click();
    await expect(page.getByTestId('meeting-research-error')).toHaveCount(0);
    await applyMeeting(page, { researchError: 'research failed: search is down' });
    await expect(page.getByTestId('meeting-research-error')).toHaveText(
      'research failed: search is down',
    );
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
    const answers = page.getByTestId('chat-stream').getByTestId('msg');
    await expect(
      answers.filter({ hasText: 'Added it.' }).getByTestId('meeting-edit-chip'),
    ).toHaveText('✓ Added to points');
    await expect(
      answers.filter({ hasText: 'Anything else?' }).getByTestId('meeting-edit-chip'),
    ).toHaveCount(0);
  });

  test('an ended meeting keeps its cards; research is locked', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_tools&meeting=ended');
    await openTopic(page, 'points ledger');
    await expect(page.getByTestId('meeting-card')).toHaveCount(2);
    await page.getByTestId('meeting-cog').click();
    await expect(page.getByTestId('meeting-research-on')).toBeDisabled();
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
