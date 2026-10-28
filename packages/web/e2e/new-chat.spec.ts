import { test, expect, type Page } from '@playwright/test';

// Real-browser e2e for the new-chat header, against the dev harness.
const NEW = '/app/dev-harness.html?chat=new';

type W = {
  __presenceStore: { getState: () => { setHostAccount: (e: unknown) => void } };
  __preferencesStore: {
    getState: () => { preferences: unknown; apply: (state: unknown) => void };
  };
};

// Same shape usage-popover.spec.ts seeds a live chat's header with — here
// pushed for the harness's default host ('d1') with no chat required, since
// the crumb this seeds is account-level (spec/14 § Chat panel header →
// Usage crumb).
async function seedUsage(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as W).__presenceStore.getState().setHostAccount({
      type: 'host.account',
      hostId: 'd1',
      backendId: 'claude-code',
      connected: true,
      accountEmail: 'dev@example.com',
      usage: {
        session: { status: 'allowed', utilization: 0.42, resetsAt: Date.now() + 3_600_000 },
      },
      accounts: [
        {
          id: 'a1',
          label: 'Default',
          connected: true,
          usage: { session: { status: 'allowed', utilization: 0.42 } },
        },
      ],
    });
    // The popover lists the account's shared subscription accounts, each read
    // off whichever host reported its usage.
    const preferences = (window as unknown as W).__preferencesStore.getState();
    preferences.apply({
      version: 1,
      settings: preferences.preferences,
      secrets: {
        claude: [{ id: 'a1', label: 'Default', connected: true, email: 'dev@example.com' }],
        codex: [],
        providerKeys: [],
      },
      hosts: [],
    });
  });
}

test.describe('new chat header', () => {
  test('"New chat" title is centred on the header', async ({ page }) => {
    await page.goto(NEW);
    const head = page.getByTestId('chat-head');
    const title = page.locator('.chat-head-title .chat-title');
    await expect(title).toHaveText('New chat');
    const headBox = (await head.boundingBox())!;
    const titleBox = (await title.boundingBox())!;
    const headCentre = headBox.x + headBox.width / 2;
    const titleCentre = titleBox.x + titleBox.width / 2;
    expect(Math.abs(titleCentre - headCentre)).toBeLessThan(20);
  });

  // spec/14 § Model selector — the list is LIVE: it comes from GET /api/models
  // (host → Anthropic), so a newly released model shows up without a
  // redeploy. Route it here and assert the picker renders exactly what the API
  // served, including a model this build has never heard of.
  test('model picker renders the live catalogue from /api/models', async ({ page }) => {
    await page.route('**/api/models*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          models: [
            { id: 'claude-opus-5', label: 'Claude Opus 5' },
            { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
            { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
          ],
          fetchedAt: '2026-08-03T09:00:00.000Z',
        }),
      }),
    );
    await page.goto(NEW);
    const model = page.getByTestId('new-chat-model');
    await expect(model).toBeVisible();
    await model.click();
    const popup = page.getByTestId('model-popup');
    await expect(popup.getByRole('option')).toHaveCount(3);
    const options = await popup.getByRole('option').allInnerTexts();
    // No synthetic "Default model" row — every option is a concrete model.
    expect(options.map((t) => t.replace('✓', '').trim())).toEqual([
      'Claude Opus 5',
      'Claude Sonnet 5',
      'Claude Haiku 4.5',
    ]);
    // Nothing chosen yet, so the picker preselects the HOST's last-used model
    // (spec/14 § Model selector) — Opus 5 in the harness greeting. The surface
    // holds no default of its own, and a spawn made here names no model at all.
    await expect(page.getByTestId('model-option-claude-opus-5')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  // NO FALLBACK: when the catalogue cannot be loaded the picker says so instead
  // of showing a plausible-looking list that may be wrong.
  test('model picker surfaces a catalogue failure instead of a stale list', async ({ page }) => {
    await page.route('**/api/models*', (r) =>
      r.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'oauth_unavailable' }),
      }),
    );
    await page.goto(NEW);
    await page.getByTestId('new-chat-model').click();
    const popup = page.getByTestId('model-popup');
    await expect(popup.getByTestId('model-popup-error')).toBeVisible();
    await expect(popup.getByRole('option')).toHaveCount(0);
  });

  // The picker used to append the raw code to its own copy ("Couldn’t load
  // models — upstream"). It now says one plain sentence, and keeps the code in
  // a collapsed Details disclosure (spec/12 § Principles).
  test('a catalogue failure reads as one sentence, with the code only in Details', async ({
    page,
  }) => {
    // A code nothing has copy for — the hard case: it must NOT be interpolated.
    await page.route('**/api/models*', (r) =>
      r.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'upstream' }),
      }),
    );
    await page.goto(NEW);
    await page.getByTestId('new-chat-model').click();
    const box = page.getByTestId('model-popup-error');
    await expect(box.locator('span').first()).toHaveText(
      'Couldn’t load the model list for that machine. Try again in a moment.',
    );
    // The code is nowhere on screen until asked for: collapsed by default.
    const detail = page.getByTestId('model-popup-error-detail');
    await expect(detail).toBeVisible();
    await expect(page.getByTestId('model-popup-error-detail-text')).toBeHidden();
    await detail.getByText('Details').click();
    await expect(page.getByTestId('model-popup-error-detail-text')).toHaveText('upstream');
  });

  // Todo "model selector is native, but folder selector is custom styled": the
  // model control must render as the SAME pill as the folder picker beside it —
  // no native <select> chrome (spec/14 § Model selector).
  test('model picker is a custom pill matching the folder pill, not a native select', async ({
    page,
  }) => {
    await page.goto(NEW);
    const model = page.getByTestId('new-chat-model');
    await expect(model).toBeVisible();
    expect(await page.getByTestId('new-chat-setup').locator('select').count()).toBe(0);

    const read = (sel: string) =>
      page.locator(sel).evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName,
          borderRadius: cs.borderTopLeftRadius,
          fontSize: cs.fontSize,
          borderWidth: cs.borderTopWidth,
          appearance: cs.appearance,
          height: Math.round((el as HTMLElement).getBoundingClientRect().height),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        };
      });
    const m = await read('[data-testid="new-chat-model"]');
    const f = await read('[data-testid="new-chat-folder-pill"]');
    expect(m.tag).toBe('BUTTON');
    expect(m.borderRadius).toBe(f.borderRadius);
    expect(m.fontSize).toBe(f.fontSize);
    expect(m.borderWidth).toBe(f.borderWidth);
    // Same visual height as the pill it sits next to.
    expect(Math.abs(m.height - f.height)).toBeLessThanOrEqual(1);
    // The label must not clip against the caret.
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);

    // The pop-up is the same construction as the folder pop-up.
    await model.click();
    const popup = page.getByTestId('model-popup');
    await expect(popup).toBeVisible();
    const popRadius = await popup.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    await page.getByTestId('new-chat-folder-pill').click();
    await expect(popup).toBeHidden();
    const folderPopRadius = await page
      .getByTestId('folder-popup')
      .evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    expect(popRadius).toBe(folderPopRadius);
  });

  test('folder picker shows no stray text under "Browse" at the roots view', async ({ page }) => {
    await page.route('**/api/folders/browse*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          dir: null,
          parent: null,
          entries: [{ name: 'portfolio', path: '/home/tom/projects/portfolio' }],
        }),
      }),
    );
    await page.goto(NEW);
    await page.getByTestId('new-chat-folder-pill').click();
    const browser = page.getByTestId('folder-browser');
    await expect(browser.getByTestId('folder-browser-entry-portfolio')).toBeVisible();
    // Between the "Browse" heading and the first drillable row there must be
    // nothing — no synthetic "Projects" crumb, no other loose text (spec/14 §8).
    await expect(page.getByTestId('folder-browser-crumb')).toHaveCount(0);
    const stray = await browser.evaluate((el) => {
      const bar = el.querySelector('.folder-browser-bar');
      const out: string[] = [];
      for (const node of Array.from(el.childNodes)) {
        if (node === bar) continue;
        if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'UL') continue;
        const t = (node.textContent ?? '').trim();
        if (t) out.push(t);
      }
      return out;
    });
    expect(stray).toEqual([]);
  });

  // spec/14 §8 § New-chat setup row — the recent projects are toggle buttons in
  // the row itself, so choosing one is a single click rather than a trip
  // through the pop-up. jsdom applies no stylesheets, so the "reads as one
  // control group" half of that only holds up in a real browser.
  test('recent projects are one-click toggles in the setup row, matching the folder pill', async ({
    page,
  }) => {
    await page.goto(NEW);
    const setup = page.getByTestId('new-chat-setup');
    const quick = setup.locator('.folder-quick');
    await expect(quick).toHaveCount(4);
    // No pop-up involved — that is the whole point of the shortcut.
    await expect(page.getByTestId('folder-popup')).toHaveCount(0);

    await expect(quick.first()).toBeVisible();
    // Both read in ONE pass, so the two measurements can't straddle a re-render.
    const metrics = await page.evaluate(() => {
      const read = (el: Element) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          borderRadius: cs.borderTopLeftRadius,
          fontSize: cs.fontSize,
          height: Math.round(r.height),
          top: Math.round(r.top),
        };
      };
      return {
        q: read(document.querySelector('.folder-quick')!),
        pill: read(document.querySelector('[data-testid="new-chat-folder-pill"]')!),
      };
    });
    expect(metrics.q.borderRadius).toBe(metrics.pill.borderRadius);
    expect(metrics.q.fontSize).toBe(metrics.pill.fontSize);
    expect(Math.abs(metrics.q.height - metrics.pill.height)).toBeLessThanOrEqual(1);
    // Sitting on the same line as the pill, not stacked above it.
    expect(Math.abs(metrics.q.top - metrics.pill.top)).toBeLessThanOrEqual(2);

    // One click selects: the button reads as pressed with a visibly different
    // fill from its unpressed peers, and the pill — no longer carrying the
    // choice — is only the way to the rest of the list.
    const second = quick.nth(1);
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.folder-pill-label')).toHaveText('Other…');
    const fills = await quick.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).backgroundColor),
    );
    expect(fills[1]).not.toBe(fills[0]);

    // Clicking it again keeps it chosen.
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'true');

    // No tooltip on any chip or pill: the name is the whole story.
    for (const el of await setup.locator('.folder-quick, .folder-pill, .model-pill').all()) {
      await expect(el).not.toHaveAttribute('title', /.*/);
    }
  });

  // Tom: "when you hover on something that's green it goes black and the
  // contrast is lost". A pressed chip keeps white text under the pointer.
  test('hovering a pressed chip keeps its text white on a deeper green', async ({ page }) => {
    await page.goto(NEW);
    const quick = page.getByTestId('new-chat-setup').locator('.folder-quick');
    const first = quick.nth(0);
    await first.click();
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    // The click left the pointer on the chip; read the resting colours with
    // it elsewhere.
    await page.mouse.move(0, 0);
    const rest = await first.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, bg: cs.backgroundColor };
    });
    await first.hover();
    await expect
      .poll(async () => first.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe(rest.bg);
    const hovered = await first.evaluate((el) => getComputedStyle(el).color);
    expect(hovered).toBe(rest.color);
    expect(hovered).toBe('rgb(255, 255, 255)');
  });

  // Todoist: "on a new chat page arrow keys left and right should allow user
  // to choose the folder to work in".
  test('Left/Right arrow keys walk the quick-folder toggle row, wrapping at the ends', async ({
    page,
  }) => {
    await page.goto(NEW);
    const setup = page.getByTestId('new-chat-setup');
    const quick = setup.locator('.folder-quick');
    await expect(quick).toHaveCount(4);
    await quick.nth(0).click();
    await expect(quick.nth(0)).toHaveAttribute('aria-pressed', 'true');

    await quick.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await expect(quick.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(quick.nth(0)).toHaveAttribute('aria-pressed', 'false');
    // Focus moved onto the newly-selected toggle, so a second press keeps
    // working without needing to re-tab into the row.
    await expect(quick.nth(1)).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(quick.nth(2)).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('ArrowRight');
    await expect(quick.nth(3)).toHaveAttribute('aria-pressed', 'true');

    // Wraps past the last toggle back to the first.
    await page.keyboard.press('ArrowRight');
    await expect(quick.nth(0)).toHaveAttribute('aria-pressed', 'true');

    // ArrowLeft wraps the other way, back to the last toggle.
    await page.keyboard.press('ArrowLeft');
    await expect(quick.nth(3)).toHaveAttribute('aria-pressed', 'true');
  });

  test('header exposes Editor, and it spawns-then-acts', async ({ page }) => {
    // create-then-act: the Editor button must first create the chat, then run.
    await page.route('**/api/chats', (r) =>
      r.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          chatId: 'c-e2e',
          folder: '/home/tom/projects/portfolio',
          status: 'pending',
        }),
      }),
    );
    await page.goto(NEW);
    await expect(page.getByTestId('new-chat-action-editor')).toBeVisible();
    // Clicking it spawns the chat (folder is MRU-seeded) and navigates away.
    await page.getByTestId('new-chat-action-editor').click();
    await expect(page.getByTestId('new-chat-main')).toHaveCount(0);
  });

  // spec/12 § Principles — one surface per failure. A refused spawn used to say
  // the same sentence twice: the toast, plus an unstyled paragraph at the top of
  // the chat panel. Two copies of one message read as a glitch.
  test('a refused spawn shows the message ONCE, in the styled toast', async ({ page }) => {
    const MESSAGE = 'folder does not exist on the host: /home/tom/projects/portfolio';
    await page.route('**/api/chats', (r) =>
      r.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'folder_not_found', message: MESSAGE }),
      }),
    );
    await page.goto(NEW);
    // Folder is MRU-seeded by the harness, so the send goes straight to spawn.
    const composer = page.getByTestId('composer-input');
    await composer.fill('my first message');
    await composer.press('Enter');

    const SENTENCE = 'That folder isn’t on that machine. Pick another project.';
    const toast = page.locator('.error-toast');
    await expect(toast).toHaveCount(1);
    await expect(toast.locator('.msg')).toHaveText(SENTENCE);
    // No second copy anywhere on the page.
    expect(await page.getByText(SENTENCE, { exact: true }).count()).toBe(1);
    await expect(page.getByTestId('new-chat-error')).toHaveCount(0);

    // The one surviving surface is STYLED, not a bare paragraph: it has the
    // toast's fill, border and radius rather than the page background.
    const style = await toast.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        background: cs.backgroundColor,
        borderWidth: cs.borderTopWidth,
        radius: cs.borderTopLeftRadius,
      };
    });
    expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(parseFloat(style.borderWidth)).toBeGreaterThan(0);
    expect(parseFloat(style.radius)).toBeGreaterThan(0);

    // Still on /chats/new with the typed message restored — the failure did not
    // eat the first message.
    await expect(page.getByTestId('new-chat-main')).toBeVisible();
    await expect(composer).toHaveValue('my first message');
  });

  // The server collapses a fast host rejection into a synchronous 400 and
  // hands the host's own paragraph straight through. That paragraph is
  // written for whoever wrote the host, so the toast must replace it — not
  // repeat it — while keeping it (spec/12 § Principles).
  test('a dispatch failure replaces the host paragraph with one sentence, code in Details', async ({
    page,
  }) => {
    const PARAGRAPH =
      'machine dev-daemon-1 has never read a model catalogue, so it has no last-used model; ' +
      'name a model on the spawn or connect the backend credential on that machine';
    await page.route('**/api/chats', (r) =>
      r.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'no_model_catalogue', message: PARAGRAPH }),
      }),
    );
    await page.goto(NEW);
    const composer = page.getByTestId('composer-input');
    await composer.fill('my first message');
    await composer.press('Enter');

    const toast = page.locator('.error-toast');
    await expect(toast.locator('.msg')).toHaveText('Pick a model before starting the chat.');
    // Neither the paragraph nor the code is anywhere visible on the page.
    await expect(page.getByText(PARAGRAPH)).toBeHidden();
    await expect(page.getByTestId('error-toast-detail-text')).toBeHidden();

    // Kept: opening Details shows the code AND the host's own words, and the
    // toast stops auto-dismissing so it can actually be read (or copied).
    await toast.getByText('Details').click();
    const detail = page.getByTestId('error-toast-detail-text');
    await expect(detail).toContainText('no_model_catalogue');
    await expect(detail).toContainText(PARAGRAPH);
    await page.waitForTimeout(7000); // past the 6s auto-dismiss
    await expect(detail).toBeVisible();
  });

  // Todoist: "the new message should immediately appear in chat for a new
  // chat. currently it goes blank for a moment, then loads it in." The
  // composer clears the instant Send is pressed regardless of what happens
  // next, so the fix is that the optimistic message + the navigation into the
  // new chat both land together, right away — not after the app has waited on
  // a WS confirmation that the host spawned the chat, which never arrives in
  // this harness (there is no live host). The pre-fix code blocked on that
  // for a full 800ms before either the message or the navigation happened at
  // all, so it reliably misses this 1000ms budget; the fix reliably clears it
  // with room to spare (both verified over repeated runs on this box).
  test('the sent message shows in the new chat immediately — no blank transcript frame', async ({
    page,
  }) => {
    await page.route('**/api/chats', (r) =>
      r.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          chatId: 'c-e2e-instant',
          folder: '/home/tom/projects/portfolio',
          status: 'pending',
        }),
      }),
    );
    await page.goto(NEW);
    const composer = page.getByTestId('composer-input');
    const TEXT = 'hello from a brand new chat';
    await composer.fill(TEXT);
    // Sample every painted frame from here on: where are the words?
    await page.evaluate((text) => {
      const frames: Array<{ inComposer: boolean; inTranscript: boolean }> = [];
      (window as unknown as { __frames: typeof frames }).__frames = frames;
      const sample = (): void => {
        const box = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
        frames.push({
          inComposer: box?.value.includes(text) ?? false,
          inTranscript: Array.from(document.querySelectorAll('.msg-user')).some((m) =>
            (m.textContent ?? '').includes(text),
          ),
        });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, TEXT);
    await composer.press('Enter');

    // The composer clears at once (optimistic) and the message shows in the
    // transcript — and never is there a painted frame with the words in
    // neither place. Checked frame by frame rather than against a stopwatch:
    // "within 1 s" was a statement about the machine, and a loaded runner
    // broke it while the app did nothing wrong.
    await expect(composer).toHaveValue('');
    await expect(page.locator('.msg-user')).toContainText(TEXT);
    const frames = await page.evaluate(
      () =>
        (window as unknown as { __frames: Array<{ inComposer: boolean; inTranscript: boolean }> })
          .__frames,
    );
    expect(frames.some((f) => f.inTranscript)).toBe(true);
    expect(frames.filter((f) => !f.inComposer && !f.inTranscript)).toEqual([]);
    // Genuinely navigated into the live chat route, not still on /chats/new
    // with the message rendered nowhere.
    await expect(page.getByTestId('new-chat-main')).toHaveCount(0);
    await expect(page.getByTestId('chat-main')).toBeVisible();
  });

  // Todoist "patch show usage things before chat has started" — the usage
  // crumb is account-level, not chat-level, so it means something before the
  // chat exists too: the one usage readout left on this header, now that a
  // live chat's header carries none of its own (spec/14 § Chat panel header —
  // its composer's context ring covers that case instead).
  test('the usage crumb is shown before the chat has started', async ({ page }) => {
    await page.goto(NEW);
    await expect(page.getByTestId('chat-usage')).toHaveCount(0);

    await seedUsage(page);
    const crumb = page.getByTestId('chat-usage');
    await expect(crumb).toBeVisible();
    await expect(crumb).toHaveAttribute('aria-label', '5-hour 42%');
    await expect(crumb.locator('.chat-usage-bar i')).toHaveAttribute('style', /width: 42%/);

    // Opens the same popover a live chat's crumb does, with no context section
    // (there is no chat, so nothing has been measured).
    await crumb.click();
    const pop = page.getByTestId('usage-popover');
    await expect(pop).toBeVisible();
    await expect(page.getByTestId('usage-pop-context')).toHaveCount(0);
    await expect(page.getByTestId('usage-pop-account')).toContainText('42%');
  });

  // Todoist: "patch flickers to full width for new message briefly when
  // sending in new chat". The pending message was drawn straight into the
  // stream, outside the measured column, so for a frame or two it spanned the
  // whole panel before the chat route took over at the reading width. The
  // message text must sit in the same place in every painted frame.
  test('the sent message text does not move when the chat route takes over', async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.route('**/api/chats', (r) =>
      r.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ chatId: 'c-e2e-width', folder: '/home/tom/x', status: 'pending' }),
      }),
    );
    await page.goto(NEW);
    const composer = page.getByTestId('composer-input');
    await composer.fill('hello from a brand new chat');
    await page.evaluate(() => {
      const spans: Array<[number, number]> = [];
      (window as unknown as { __spans: typeof spans }).__spans = spans;
      const sample = (): void => {
        for (const c of document.querySelectorAll('.msg-user .content')) {
          const r = c.getBoundingClientRect();
          spans.push([Math.round(r.left), Math.round(r.right)]);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await composer.press('Enter');
    await expect(page.getByTestId('chat-main')).toBeVisible();
    await expect(page.locator('.msg-user')).toBeVisible();
    await page.waitForTimeout(300);
    const spans = await page.evaluate(
      () => (window as unknown as { __spans: Array<[number, number]> }).__spans,
    );
    expect(spans.length).toBeGreaterThan(0);
    const settled = spans[spans.length - 1];
    for (const [left, right] of spans) {
      expect(Math.abs(left - settled[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(right - settled[1])).toBeLessThanOrEqual(1);
    }
  });
});
