import { test, expect, type Locator, type Page } from '@playwright/test';

// Real-browser e2e for the live dictation preview (spec/07 § Dictation into the
// composer): while the mic runs, the host's interim transcript is painted
// GREYED behind the composer input, and the input stays editable throughout.
//
// This is the half jsdom cannot answer. The unit tests already assert which
// text goes where; what needs a real browser is that the mirror LINES UP with
// the textarea, that the preview ink is the placeholder grey rather than the
// body ink, and that the textarea's own glyphs go transparent without taking
// the caret with them.
//
// Everything below the component is stubbed at its boundary and nothing above
// it is: the real Composer, the real recorder, the real audioSession decoder
// and the real CSS all run.
//
//   - The mic, because this machine has no audio device (Chromium cannot
//     enumerate even its own fake one), so `getUserMedia` returns a real but
//     silent Web Audio MediaStream.
//   - The WebSocket, because there is no host behind the dev harness. The
//     fake speaks the real wire frames: it accepts `audio.session_start` and
//     answers with `audio.transcript_partial`, which is exactly what a host
//     doing prefix re-transcription sends.
//   - `/api/auth/me` and `/api/voice/token`, the two calls that precede the
//     socket, plus the stored surface credential they are read alongside.

/** A surface credential JWT — shape only; nothing here verifies a signature. */
const CREDENTIAL = (() => {
  const b64 = (o: unknown): string =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64({ alg: 'EdDSA', typ: 'JWT' })}.${b64({
    surface_id: 'surface_e2e',
    surface_kind: 'web',
  })}.sig`;
})();

const BOOT = `
  window.localStorage.setItem('patch.credential.v1', ${JSON.stringify(CREDENTIAL)});
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext();
    return ctx.createMediaStreamDestination().stream; // real stream, real silence
  };
  // A host that re-transcribes the growing prefix: two passes, the second
  // rewriting the first, which is the jitter the preview styling exists for.
  const RealWS = window.WebSocket;
  window.WebSocket = class extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    binaryType = 'arraybuffer';
    constructor(url) {
      super();
      this.url = url;
      setTimeout(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      }, 0);
    }
    send(data) {
      if (typeof data !== 'string') return; // mic PCM frames
      const frame = JSON.parse(data);
      if (frame.type !== 'audio.session_start') return;
      const say = (text, delay) =>
        setTimeout(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'audio.transcript_partial',
                sessionId: frame.sessionId,
                text,
              }),
            }),
          );
        }, delay);
      say('remind me to', 30);
      say('remind me to water the', 120);
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent('close'));
    }
  };
  window.__RealWS = RealWS;
`;

const CHAT = '/app/dev-harness.html?chat=thread_manager';

async function stubVoiceRoutes(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/auth/me', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        account: { accountId: 'acct_e2e', userPublicKey: 'pk', createdAt: 0 },
      }),
    }),
  );
  await page.route('**/api/voice/token', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token: 't',
        sessionId: 'sess_e2e',
        audioUrl: '/audio/sess_e2e',
        expiresAt: Date.now() + 60_000,
      }),
    }),
  );
}

/**
 * Tap the mic: down and up in one page-side call, so the press is unambiguously
 * a tap. Waits for the button first — a disabled one (the composer before its
 * host reports in) gets no mousedown at all, and a tap dispatched straight after
 * load on a slow runner did nothing.
 */
async function tapMic(mic: Locator): Promise<void> {
  await expect(mic).toBeEnabled();
  await mic.evaluate((el) => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

/**
 * Tap a chord as a person does: down, then up 50 ms later BY THE EVENTS' OWN
 * CLOCK. `keyboard.press` sends the keyup only once the page has handled the
 * keydown, so on a loaded runner the two were seconds apart and the tap read
 * as a hold (which commits on release). The app times a hold by the events'
 * `timeStamp`, and this sets them.
 */
async function tapChord(
  page: Page,
  code: 'KeyD' | 'KeyM',
  mods: { meta?: boolean; shift?: boolean; alt?: boolean },
): Promise<void> {
  // The chord reaches the composer's mic, which ignores it while disabled.
  await expect(page.getByTestId('voice-note-btn')).toBeEnabled();
  const cdp = await page.context().newCDPSession(page);
  const modifiers = (mods.alt ? 1 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
  const letter = code.slice(3);
  const key = mods.shift ? letter : letter.toLowerCase();
  const base = { modifiers, key, code, windowsVirtualKeyCode: letter.charCodeAt(0) };
  const at = Date.now() / 1000;
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, timestamp: at });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base, timestamp: at + 0.05 });
  await cdp.detach();
}

test.describe('composer dictation — live preview', () => {
  test('⌘⇧D dictates into the composer: grey while talking, ⌘⇧D again keeps it', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript(BOOT);
    await stubVoiceRoutes(page);
    await page.route('**/api/voice/transcribe*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ transcript: 'water the ferns' }),
      }),
    );
    await page.goto(`${CHAT}&ws=fake`);
    const input = page.getByTestId('composer-input');
    await input.click();
    // Start and cancel once first, so the run below is not also the mic's
    // first ever start.
    await tapChord(page, 'KeyD', { meta: true, shift: true });
    await expect(page.getByTestId('voice-note-btn')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('voice-note-btn')).toHaveAttribute('aria-pressed', 'false');
    await expect(input).toHaveValue('');

    await tapChord(page, 'KeyD', { meta: true, shift: true });
    await expect(page.getByTestId('composer-live-partial')).toHaveText(
      /^\s*🎤 remind me to water the$/,
    );
    // Not the voice-note overlay: the words are in the box, not above it.
    await expect(page.getByTestId('voice-note-overlay')).toHaveCount(0);

    await tapChord(page, 'KeyD', { meta: true, shift: true });
    await expect(input).toHaveValue('water the ferns');
    await expect(page.getByTestId('composer-live-preview')).toHaveCount(0);
    // Nothing was SENT as a message. The draft sync (`composer_draft.set`)
    // rightly carries the text to other surfaces — it is what is in the box —
    // and under load its debounce fired before this read, so the check is on
    // the frames that would post a turn, not on every frame.
    const turns = await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as { __wsSent: Array<{ type: string }> }).__wsSent.filter(
          (f) => f.type === 'chat.input',
        ),
      ),
    );
    expect(turns).not.toContain('water the ferns');
  });

  test('a chord rebound in Settings drives dictation, and ⌘⇧D no longer does', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(BOOT);
    await page.addInitScript(() => {
      localStorage.setItem(
        'patch.voice.dictateChord',
        JSON.stringify({ alt: true, shift: false, code: 'KeyM' }),
      );
    });
    await stubVoiceRoutes(page);
    await page.goto(`${CHAT}&ws=fake`);
    await page.getByTestId('composer-input').click();
    await tapChord(page, 'KeyD', { meta: true, shift: true });
    await expect(page.getByTestId('voice-note-btn')).toHaveAttribute('aria-pressed', 'false');
    await tapChord(page, 'KeyM', { meta: true, alt: true });
    await expect(page.getByTestId('voice-note-btn')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('voice-note-btn')).toHaveAttribute('aria-pressed', 'false');
  });

  test('send mid-dictation ends it and sends typed text plus transcript', async ({ page }) => {
    // `ws=fake` records the turn frame on `__wsSent`.
    test.setTimeout(60_000);
    await page.addInitScript(BOOT);
    await stubVoiceRoutes(page);
    await page.route('**/api/voice/transcribe*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ transcript: 'water the ferns' }),
      }),
    );
    await page.goto(`${CHAT}&ws=fake`);
    const mic = page.getByTestId('voice-note-btn');
    const input = page.getByTestId('composer-input');

    await input.fill('please');
    await tapMic(mic);
    await expect(page.getByTestId('composer-live-partial')).toHaveText(
      /^\s*🎤 remind me to water the$/,
    );
    await expect(mic).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('send-btn').click();

    // The harness has no host; the turn is observable as the frame it sends.
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.stringify((window as unknown as { __wsSent: unknown[] }).__wsSent),
        ),
      )
      .toContain('please water the ferns');
    await expect(input).toHaveValue('');
    await expect(mic).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('composer-live-preview')).toHaveCount(0);
  });

  test('paints the interim transcript greyed over an editable input', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(BOOT);
    await page.route('**/api/auth/me', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          account: { accountId: 'acct_e2e', userPublicKey: 'pk', createdAt: 0 },
        }),
      }),
    );
    await page.route('**/api/voice/token', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          token: 't',
          sessionId: 'sess_e2e',
          audioUrl: '/audio/sess_e2e',
          expiresAt: Date.now() + 60_000,
        }),
      }),
    );

    await page.goto(CHAT);
    const mic = page.getByTestId('voice-note-btn');
    const input = page.getByTestId('composer-input');

    // Type first: the preview has to follow the user's own text, not replace it.
    await input.fill('note:');
    await tapMic(mic);

    // The second pass REPLACES the first rather than appending to it — the
    // interim text is a fresh read of the whole prefix each time, and the
    // preview must show the latest read, not a concatenation of every read.
    const partial = page.getByTestId('composer-live-partial');
    await expect(partial).toHaveText(/^\s*🎤 remind me to water the$/);

    // The typed text is still the only REAL value — the guess is not committed.
    await expect(input).toHaveValue('note:');

    // Greyed: the partial takes the placeholder ink, the committed run does not.
    const inkPartial = await partial.evaluate((el) => getComputedStyle(el).color);
    const inkCommitted = await page
      .locator('.composer-live-committed')
      .evaluate((el) => getComputedStyle(el).color);
    expect(inkPartial).not.toBe(inkCommitted);
    const placeholderInk = await input.evaluate((el) =>
      getComputedStyle(el.ownerDocument.documentElement).getPropertyValue('--ink-3').trim(),
    );
    expect(placeholderInk.length).toBeGreaterThan(0);

    // The textarea's own glyphs are transparent so the mirror shows through,
    // but it keeps a visible caret and stays editable.
    const style = await input.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        color: cs.color,
        caret: cs.caretColor,
        disabled: (el as HTMLTextAreaElement).disabled,
      };
    });
    expect(style.color).toBe('rgba(0, 0, 0, 0)');
    expect(style.caret).not.toBe('rgba(0, 0, 0, 0)');
    expect(style.disabled).toBe(false);

    // The mirror sits exactly over the input, so the greyed words read as
    // continuing the line rather than floating beside it.
    const boxes = await page.evaluate(() => {
      const ta = document.querySelector('.composer-input')!.getBoundingClientRect();
      const mirror = document.querySelector('.composer-live-preview')!.getBoundingClientRect();
      return {
        ta: { x: ta.x, y: ta.y, w: ta.width },
        mirror: { x: mirror.x, y: mirror.y, w: mirror.width },
      };
    });
    expect(Math.abs(boxes.mirror.x - boxes.ta.x)).toBeLessThan(1);
    expect(Math.abs(boxes.mirror.y - boxes.ta.y)).toBeLessThan(1);
    expect(Math.abs(boxes.mirror.w - boxes.ta.w)).toBeLessThan(1);

    // Still typeable mid-dictation.
    await input.fill('note: typed anyway');
    await expect(input).toHaveValue('note: typed anyway');

    // Ending the dictation drops the preview entirely.
    await page.route('**/api/voice/transcribe*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ transcript: 'water the plants' }),
      }),
    );
    await tapMic(mic);
    await expect(page.getByTestId('composer-live-preview')).toHaveCount(0);
  });
});

// Todoist 6hjvWFWppq7GJWWc — "patch not displaying transcript while i'm
// speaking in dictation mode". The voice NOTE (⌃Space, ⌘;, the new-chat mic) is
// dictation too, and its overlay stayed on `…` until the upload came back. Same
// real recorder, real audioSession decoder and real CSS as above; only the mic
// and the socket are stood in for.
test.describe('voice note — live transcript', () => {
  test("the overlay shows the host's words while the note is still being spoken", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript(BOOT);
    await stubVoiceRoutes(page);
    await page.goto(`${CHAT}&ws=fake`);
    await page.waitForFunction(
      () => (window as unknown as { __startVoiceNote?: unknown }).__startVoiceNote !== undefined,
    );
    await page.evaluate(() =>
      (
        window as unknown as { __startVoiceNote: (c: string, g: string) => Promise<void> }
      ).__startVoiceNote('thread_manager', 'toggle'),
    );
    const line = page.getByTestId('voice-note-transcript');
    await expect(line).toBeVisible();
    // The second pass rewrites the first, exactly as a prefix re-transcription does.
    await expect(line).toHaveText('remind me to water the');
    // Visible to a human, not just present in the DOM.
    const box = (await line.boundingBox())!;
    expect(box.width).toBeGreaterThan(40);
    expect(box.height).toBeGreaterThan(8);
    await page.screenshot({ path: 'test-results/voice-note-live-transcript.png' });
    await page.evaluate(() =>
      (window as unknown as { __cancelVoiceNote: () => void }).__cancelVoiceNote(),
    );
    await expect(page.getByTestId('voice-note-overlay')).toHaveCount(0);
  });
});
