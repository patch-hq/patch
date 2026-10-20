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

  test('the bar sits across the top, above both the chat and the side panel', async ({ page }) => {
    await page.goto(URL_LIVE);
    const [bar, stream, pan] = await Promise.all([
      page.getByTestId('meeting-bar').boundingBox(),
      page.getByTestId('chat-stream').boundingBox(),
      page.getByTestId('meeting-panel').boundingBox(),
    ]);
    expect(bar!.y + bar!.height).toBeLessThanOrEqual(stream!.y + 1);
    expect(bar!.y + bar!.height).toBeLessThanOrEqual(pan!.y + 1);
    expect(bar!.width).toBeGreaterThan(stream!.width + pan!.width - 2);
    await expect(page.getByTestId('meeting-panel').getByTestId('meeting-drawer')).toHaveCount(0);
  });

  test('the transcript appears in one place only: the bar drawer', async ({ page }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-drawer')).toBeVisible();
    await expect(page.getByTestId('meeting-panel').getByTestId('meeting-line')).toHaveCount(0);
    await expect(page.getByTestId('meeting-panel')).not.toContainText('Transcript');
    await expect(page.getByTestId('meeting-search')).toHaveCount(0);
  });

  test('the panel has Points and My notes tabs and a cog', async ({ page }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-tab-points')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('meeting-points')).toBeVisible();
    await page.getByTestId('meeting-tab-notes').click();
    await expect(page.getByTestId('meeting-tab-notes')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('meeting-points')).toHaveCount(0);
    await expect(page.getByTestId('meeting-cog')).toBeVisible();
  });

  test('My notes: typing saves to the host, survives switching tabs, and shows in dark ink', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-tab-notes').click();
    const box = page.getByTestId('meeting-my-notes');
    await expect(box).toBeVisible();
    await box.click();
    await page.keyboard.type('Ask Priya about the rollout');
    await expect.poll(async () => (await sent(page, 'meeting.my_notes_request')).length).toBe(1);
    expect((await sent(page, 'meeting.my_notes_request'))[0]).toMatchObject({
      chatId: 'chat_tools',
      text: 'Ask Priya about the rollout',
    });
    await page.getByTestId('meeting-tab-points').click();
    await page.getByTestId('meeting-tab-notes').click();
    await expect(page.getByTestId('meeting-my-notes')).toHaveValue('Ask Priya about the rollout');
    const [ink, ink1, ink2] = await page.evaluate(() => {
      const colour = (v: string) => {
        const d = document.createElement('div');
        d.style.color = `var(${v})`;
        document.body.appendChild(d);
        const c = getComputedStyle(d).color;
        d.remove();
        return c;
      };
      return [
        getComputedStyle(document.querySelector('[data-testid="meeting-my-notes"]')!).color,
        colour('--ink'),
        colour('--ink-2'),
      ];
    });
    expect(ink).toBe(ink1);
    expect(ink).not.toBe(ink2);
  });

  test('My notes: text saved from another surface appears, and blur saves at once', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-tab-notes').click();
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __meetingStore: {
            getState: () => {
              byChat: Record<string, object>;
              apply: (c: string, m: object) => void;
            };
          };
        }
      ).__meetingStore;
      const st = store.getState();
      st.apply('chat_tools', { ...st.byChat['chat_tools']!, myNotes: 'From the laptop' });
    });
    await expect(page.getByTestId('meeting-my-notes')).toHaveValue('From the laptop');
    const box = page.getByTestId('meeting-my-notes');
    await box.fill('Follow up Friday');
    await box.blur();
    expect((await sent(page, 'meeting.my_notes_request')).at(-1)).toMatchObject({
      text: 'Follow up Friday',
    });
  });

  test('the cog opens prompts, models and timing in place', async ({ page }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-settings')).toHaveCount(0);
    await page.getByTestId('meeting-cog').click();
    const s = page.getByTestId('meeting-settings');
    await expect(s.getByTestId('meeting-analysis-model')).toBeVisible();
    await expect(s.getByTestId('meeting-analyse-seconds')).toBeVisible();
    await expect(s.getByTestId('meeting-speed')).toBeVisible();
    await s.getByTestId('meeting-prompt-open-notes').click();
    await expect(s.getByTestId('meeting-prompt-editor')).toBeVisible();
    await page.getByTestId('meeting-tab-points').click();
    await expect(page.getByTestId('meeting-settings')).toHaveCount(0);
    await expect(page.getByTestId('meeting-panel')).toBeVisible();
  });

  test('the header names who is on the call, and there is no auto-end setting', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.evaluate(() => {
      const store = (window as unknown as { __meetingStore: any }).__meetingStore;
      const cur = store.getState().byChat['chat_tools'];
      store.getState().apply('chat_tools', {
        ...cur,
        transcript: [
          { at: 1000, speaker: 'them', name: 'Ada', text: 'hello' },
          { at: 2000, speaker: 'them', name: 'Bo', text: 'hi' },
          { at: 3000, speaker: 'them', text: 'unnamed' },
          { at: 4000, speaker: 'you', text: 'ok' },
        ],
      });
    });
    await expect(page.getByTestId('meeting-people')).toHaveText('Ada · Bo · You');
    await expect(page.getByTestId('meeting-bar')).not.toContainText(/auto-?end/i);
    await expect(page.getByTestId('meeting-now-label')).toHaveText('Now · You');
  });

  test.describe('transcript drawer', () => {
    const seed = (page: Page, count = 40) =>
      page.evaluate((n) => {
        const store = (window as unknown as { __meetingStore: any }).__meetingStore;
        const cur = store.getState().byChat['chat_tools'];
        store.getState().apply('chat_tools', {
          ...cur,
          live: 'so can we ship on Friday',
          transcript: Array.from({ length: n }, (_, i) => ({
            at: i * 1000,
            speaker: 'them',
            name: i % 2 ? 'Ada' : 'Bo',
            text: `sample line ${i}`,
          })),
        });
      }, count);

    test('closed shows only the live line, speaker bold and words italic', async ({ page }) => {
      await page.goto(URL_LIVE);
      await seed(page);
      const live = page.getByTestId('meeting-live');
      await expect(live).toContainText('so can we ship on Friday');
      await expect(live.locator('b')).toHaveText('Ada');
      expect(await live.evaluate((el) => getComputedStyle(el).fontStyle)).toBe('italic');
      expect(await live.locator('b').evaluate((el) => getComputedStyle(el).fontWeight)).toBe('700');
      await expect(page.getByTestId('meeting-line')).toHaveCount(0);
      await expect(page.getByTestId('meeting-now-label')).toHaveText('Now · Ada');
    });

    test('tap opens to about half the window and toggles back closed', async ({ page }) => {
      await page.goto(URL_LIVE);
      await seed(page);
      const grip = page.getByTestId('meeting-grip');
      await grip.click();
      await expect(page.getByTestId('meeting-line')).toHaveCount(40);
      const win = page.viewportSize()!.height;
      const h = (await page.getByTestId('meeting-lines').boundingBox())!.height;
      expect(h).toBeGreaterThan(win * 0.35);
      expect(h).toBeLessThan(win * 0.6);
      await grip.click();
      await expect(page.getByTestId('meeting-line')).toHaveCount(0);
      await expect(page.getByTestId('meeting-live')).toBeVisible();
    });

    test('dragging the divider opens it, capped at 75% of the window', async ({ page }) => {
      await page.goto(URL_LIVE);
      await seed(page);
      const grip = page.getByTestId('meeting-grip');
      const g = (await grip.boundingBox())!;
      const x = g.x + g.width / 2;
      const y = g.y + g.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 150, { steps: 5 });
      await page.mouse.up();
      await expect(page.getByTestId('meeting-lines')).toBeVisible();
      const win = page.viewportSize()!.height;
      const bar1 = (await page.getByTestId('meeting-bar').boundingBox())!.height;
      expect(bar1).toBeGreaterThan(150);
      await page.mouse.move(x, y + 150);
      const g2 = (await grip.boundingBox())!;
      await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
      await page.mouse.down();
      await page.mouse.move(g2.x + g2.width / 2, win + 400, { steps: 5 });
      await page.mouse.up();
      const bar2 = (await page.getByTestId('meeting-bar').boundingBox())!.height;
      expect(bar2).toBeLessThanOrEqual(win * 0.75 + 2);
      expect(bar2).toBeGreaterThan(win * 0.6);
    });

    test('open, earlier lines with the latest at the bottom', async ({ page }) => {
      await page.goto(URL_LIVE);
      await seed(page);
      await page.getByTestId('meeting-grip').click();
      const lines = page.getByTestId('meeting-line');
      await expect(lines.last()).toContainText('sample line 39');
      await expect(lines.first()).toContainText('sample line 0');
      expect(
        await page.getByTestId('meeting-lines').evaluate((el) => el.scrollHeight > el.clientHeight),
      ).toBe(true);
    });

    test('no horizontal scroll at 390px', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto(URL_LIVE);
      await seed(page);
      const overflow = () =>
        page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(await overflow()).toBe(false);
      await page.getByTestId('meeting-grip').click();
      expect(await overflow()).toBe(false);
      await page.getByTestId('meeting-grip').click();
      await page.getByTestId('meeting-cog').click();
      expect(await overflow()).toBe(false);
      const bar = (await page.getByTestId('meeting-bar').boundingBox())!;
      expect(bar.x + bar.width).toBeLessThanOrEqual(390);
    });
  });

  test('transcript stays pinned to the latest line until Tom scrolls up', async ({ page }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-grip').click();
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

  test('shows Live + timer and points newest first, decisions marked in the text with no chips', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-pill')).toContainText(/Live · 3\d:\d\d/);
    const topics = page.getByTestId('meeting-topic');
    await expect(topics).toHaveCount(3);
    await expect(topics.first()).toContainText('failing tests');
    await expect(topics.last()).toContainText('release 4.2');
    await expect(topics.locator('.decw')).toHaveCount(2);
    await expect(topics.locator('.decw').first()).toHaveText('Decision:');
    await expect(page.locator('.mm-dec')).toHaveCount(0);
    await expect(
      page.getByTestId('meeting-panel').getByRole('button', { name: /^(Edit|Add bullet)$/ }),
    ).toHaveCount(0);
  });

  test('points taper: newest 15px with bullets, recent 14px with bullets, older one line', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.evaluate(() => {
      const store = (window as unknown as { __meetingStore: any }).__meetingStore;
      const cur = store.getState().byChat['chat_tools'];
      const extra = Array.from({ length: 5 }, (_, i) => ({
        id: `x${i}`,
        at: 40 * 60_000 + i * 60_000,
        title: `Speaker ${i}: argument ${i}`,
        points: ['detail'],
        decided: false,
      }));
      store.getState().apply('chat_tools', { ...cur, topics: [...cur.topics, ...extra] });
    });
    const topics = page.getByTestId('meeting-topic');
    const size = (i: number) =>
      topics
        .nth(i)
        .locator('.nm')
        .evaluate((el) => getComputedStyle(el).fontSize);
    const weight = (i: number) =>
      topics
        .nth(i)
        .locator('.nm')
        .evaluate((el) => getComputedStyle(el).fontWeight);
    await expect(topics).toHaveCount(8);
    expect(await size(0)).toBe('15px');
    expect(await size(1)).toBe('14px');
    expect(await weight(1)).toBe('600');
    await expect(topics.nth(0).locator('li').first()).toBeVisible();
    await expect(topics.nth(1).locator('li').first()).toBeVisible();
    await expect(topics.nth(5).locator('li').first()).toBeHidden();
    expect(await size(7)).toBe('12px');
  });

  test('clicking a point title edits it in place and sends the edit', async ({ page }) => {
    await page.goto(URL_LIVE);
    const title = page.getByTestId('meeting-point-title').first();
    await title.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Sam: the tests fail because the sandbox has no credit');
    await page.keyboard.press('Tab');
    const reqs = (await sent(page, 'meeting.notes_request')) as Array<{ edit: unknown }>;
    expect(reqs.at(-1)!.edit).toMatchObject({
      op: 'set_title',
      text: 'Sam: the tests fail because the sandbox has no credit',
    });
    await expect(page.getByTestId('meeting-point-title').first()).toHaveText(
      'Sam: the tests fail because the sandbox has no credit',
    );
  });

  test('editing a decision keeps its Decision: prefix', async ({ page }) => {
    await page.goto(URL_LIVE);
    const t = page.getByTestId('meeting-topic').last();
    await t.getByTestId('meeting-point-title').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Priya: release 4.2 ships on Tuesday');
    await page.keyboard.press('Tab');
    const reqs = (await sent(page, 'meeting.notes_request')) as Array<{ edit: { text: string } }>;
    expect(reqs.at(-1)!.edit.text).toBe('Decision: Priya: release 4.2 ships on Tuesday');
  });

  test('Enter in a bullet starts a new bullet and the caret lands in it', async ({ page }) => {
    await page.goto(URL_LIVE);
    const first = page.getByTestId('meeting-topic').first();
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
    const last = page.getByTestId('meeting-topic').nth(2);
    await last.getByTestId('meeting-point-title').click();
    await page.keyboard.press('Enter');
    await expect(last.getByTestId('meeting-point-bullet').first()).toBeFocused();
    await expect(last.getByTestId('meeting-point-bullet')).toHaveCount(2);
    await page.keyboard.press('Enter');
    await expect(last.getByTestId('meeting-point-bullet')).toHaveCount(1);
    await expect(last.getByTestId('meeting-point-bullet').first()).toHaveText('Ships Monday');
  });

  test('hovering a point shows a round + above it that inserts a new point there', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const topics = page.getByTestId('meeting-topic');
    const target = topics.nth(1);
    const plus = target.getByTestId('meeting-point-insert');
    await expect(plus).toHaveCSS('opacity', '0');
    await target.hover();
    await expect(plus).toHaveCSS('opacity', '1');
    const [pb, tb] = await Promise.all([plus.boundingBox(), target.boundingBox()]);
    expect(pb!.y).toBeLessThan(tb!.y + 4);
    expect(pb!.width).toBe(pb!.height);
    await plus.click();
    await expect(topics).toHaveCount(4);
    // the new point sits above the one it was inserted at, and takes the caret
    await expect(topics.nth(1).getByTestId('meeting-point-title')).toBeFocused();
    await expect(topics.nth(2)).toContainText('split the points ledger');
    await page.keyboard.type('Tom: ship it on Friday');
    await page.keyboard.press('Tab');
    await expect(topics.nth(1).getByTestId('meeting-point-title')).toHaveText(
      'Tom: ship it on Friday',
    );
    const ops = (
      (await sent(page, 'meeting.notes_request')) as Array<{ edit: { op: string } }>
    ).map((r) => r.edit.op);
    expect(ops).toEqual(['insert', 'set_title']);
  });

  test('an inserted point left empty is removed again', async ({ page }) => {
    await page.goto(URL_LIVE);
    const topics = page.getByTestId('meeting-topic');
    await topics.first().hover();
    await topics.first().getByTestId('meeting-point-insert').click();
    await expect(topics).toHaveCount(4);
    await page.getByTestId('meeting-tab-notes').click();
    await page.getByTestId('meeting-tab-points').click();
    await expect(topics).toHaveCount(3);
  });

  test("clicking a point's time shows the transcript lines it came from, indented under it", async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const newest = page.getByTestId('meeting-topic').first();
    await expect(newest.getByTestId('meeting-point-lines')).toHaveCount(0);
    await newest.getByTestId('meeting-point-time').click();
    const lines = newest.getByTestId('meeting-point-line');
    await expect(lines).toHaveCount(2);
    await expect(lines.first()).toContainText('busiest week of the year');
    const [title, line] = await Promise.all([
      newest.getByTestId('meeting-point-title').boundingBox(),
      lines.first().boundingBox(),
    ]);
    expect(line!.x).toBeGreaterThanOrEqual(title!.x - 1);
    await newest.getByTestId('meeting-point-time').click();
    await expect(newest.getByTestId('meeting-point-lines')).toHaveCount(0);
  });

  test('the live line shows what is being said, and the speed option tunes the host', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-live')).toContainText('statement run');
    await page.evaluate(() => {
      const store = (window as unknown as { __meetingStore: any }).__meetingStore;
      const cur = store.getState().byChat['chat_tools'];
      store.getState().apply('chat_tools', { ...cur, live: 'so can we ship on Friday' });
    });
    await expect(page.getByTestId('meeting-live')).toContainText('so can we ship on Friday');
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

  test('the tray counts actions by kind and has one compact row each', async ({ page }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-actions-count')).toHaveText(
      '1 mine · 1 others · 1 agent',
    );
    const rows = page.getByTestId('meeting-action');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-kind', 'mine');
    await expect(rows.nth(1)).toHaveAttribute('data-kind', 'other');
    await expect(rows.nth(2)).toHaveAttribute('data-kind', 'agent');
    const body = await page.getByTestId('meeting-actions-body').boundingBox();
    expect(body!.height).toBeLessThanOrEqual(171);
  });

  test("Tom's action offers Start chat, not Do it; someone else's offers only an owner and ✕", async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
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
    const owner = page.getByTestId('meeting-action').nth(1).getByTestId('meeting-action-owner');
    await expect(owner.locator('option')).toHaveText(['Priya', 'Dev', 'Everyone']);
    await owner.selectOption('Everyone');
    const reqs = (await sent(page, 'meeting.action_request')) as Array<Record<string, unknown>>;
    expect(reqs).toEqual([
      { type: 'meeting.action_request', chatId: 'chat_tools', actionId: 'a2', owner: 'Everyone' },
    ]);
    await expect(owner).toHaveValue('Everyone');
  });

  test('agent actions: Run until the checkbox is on, then status and Open chat', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const agent = page.getByTestId('meeting-action').nth(2);
    const box = page.getByTestId('meeting-agent-runs');
    await expect(box).toHaveAttribute('title', 'Agent runs its own actions');
    await expect(box).not.toBeChecked();
    await expect(agent.getByTestId('meeting-action-do')).toHaveText('Run');
    await box.check();
    expect(await sent(page, 'meeting.action_request')).toEqual([
      { type: 'meeting.action_request', chatId: 'chat_tools', agentRuns: true },
    ]);
    await expect(box).toBeChecked();
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

  test('every action can be dismissed and the tray collapses', async ({ page }) => {
    await page.goto(URL_LIVE);
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

  test('the caret collapses the tray body', async ({ page }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-actions-body')).toBeVisible();
    await page.getByTestId('meeting-actions-toggle').click();
    await expect(page.getByTestId('meeting-actions-body')).toHaveCount(0);
    await expect(page.getByTestId('meeting-actions-count')).toBeVisible();
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
    await expect(page.getByTestId('meeting-action')).toHaveCount(3);
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
    await expect(page.getByTestId('meeting-live')).toContainText('Listening');
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

test.describe('meeting mode — agent feed', () => {
  test('sits at the top of the left column: header with the checkbox, cards, then the chat and composer', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const feed = page.getByTestId('meeting-feed');
    await expect(feed).toBeVisible();
    await expect(feed).toContainText('Agent');
    await expect(page.getByTestId('meeting-research-on')).toBeChecked();
    await expect(feed).toContainText('Research as we go');
    const [f, stream, composer, panel] = await Promise.all([
      feed.boundingBox(),
      page.getByTestId('chat-stream').boundingBox(),
      page.getByTestId('composer').boundingBox(),
      page.getByTestId('meeting-panel').boundingBox(),
    ]);
    expect(f!.y + f!.height).toBeLessThanOrEqual(stream!.y + 1);
    expect(stream!.y + stream!.height).toBeLessThanOrEqual(composer!.y + 1);
    expect(f!.x + f!.width).toBeLessThanOrEqual(panel!.x + 1);
  });

  test('shows the three card types by a coloured label, with title, time, bullets and no left bar', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    const cards = page.getByTestId('meeting-card');
    await expect(cards).toHaveCount(3);
    // newest first
    await expect(cards.nth(0).getByTestId('meeting-card-title')).toHaveText('Harbour levy');
    await expect(cards.nth(0).getByTestId('meeting-card-kind')).toHaveText('Explained');
    await expect(cards.nth(0)).toContainText('24:46');
    await expect(cards.nth(1).getByTestId('meeting-card-kind')).toHaveText('Fact check');
    await expect(cards.nth(2).getByTestId('meeting-card-kind')).toHaveText('Answer');
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
    const fact = page.getByTestId('meeting-card').nth(1);
    await expect(fact.getByTestId('meeting-card-title')).toHaveText(
      '"The ferry carries about fifty cars"',
    );
    await expect(fact.getByTestId('meeting-card-verdict')).toHaveText('Off');
    const link = fact.getByTestId('meeting-card-source');
    await expect(link).toHaveText('Operator fleet page');
    await expect(link).toHaveAttribute('href', 'https://example.org/fleet');
    await expect(link).toHaveAttribute('target', '_blank');
    // other kinds have no verdict
    await expect(page.getByTestId('meeting-card-verdict')).toHaveCount(1);
  });

  test('the checkbox tells the host, and the host says research failed where the cards are', async ({
    page,
  }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-research-on').uncheck();
    await expect.poll(async () => (await sent(page, 'meeting.research_request')).length).toBe(1);
    expect((await sent(page, 'meeting.research_request'))[0]).toMatchObject({ on: false });
    await expect(page.getByTestId('meeting-research-on')).not.toBeChecked();
    await expect(page.getByTestId('meeting-research-error')).toHaveCount(0);
    await page.evaluate(() => {
      const st = (
        window as unknown as {
          __meetingStore: {
            getState(): {
              byChat: Record<string, object>;
              apply(id: string, m: object): void;
            };
          };
        }
      ).__meetingStore.getState();
      const [id, m] = Object.entries(st.byChat)[0]!;
      st.apply(id, { ...m, researchError: 'research failed: search is down' });
    });
    await expect(page.getByTestId('meeting-research-error')).toHaveText(
      'research failed: search is down',
    );
  });

  test('a reply that changed the notes carries a chip, and only that reply', async ({ page }) => {
    await page.goto(URL_LIVE);
    await expect(page.getByTestId('meeting-edit-chip')).toHaveCount(0);
    await page.evaluate(() => {
      const st = (
        window as unknown as {
          __meetingStore: {
            getState(): {
              byChat: Record<string, object>;
              apply(id: string, m: object): void;
            };
          };
        }
      ).__meetingStore.getState();
      const [id, m] = Object.entries(st.byChat)[0]!;
      st.apply(id, {
        ...m,
        agentEdits: [{ id: 'e1', at: 1760000000000 + 5000, label: 'Added to points' }],
      });
    });
    const chips = page.getByTestId('meeting-edit-chip');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toHaveText('✓ Added to points');
    // inside the first agent reply, not a later one
    const first = page.getByTestId('msg').filter({ has: chips }).first();
    await expect(first).toHaveAttribute('data-message-at', String(1760000000000 + 14_000));
  });

  test('an ended meeting keeps its cards but the checkbox is locked', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_tools&meeting=ended');
    await expect(page.getByTestId('meeting-card')).toHaveCount(3);
    await expect(page.getByTestId('meeting-research-on')).toBeDisabled();
  });

  test('the cog holds the research model and the least gap between passes', async ({ page }) => {
    await page.goto(URL_LIVE);
    await page.getByTestId('meeting-cog').click();
    await expect(page.getByTestId('meeting-research-model')).toBeVisible();
    await expect(page.getByTestId('meeting-research-seconds')).toHaveValue('60');
  });
});
