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
      const long = Array.from({length: 40}, (_, i) => 'word' + i).join(' ');
      say(long, 30);
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent('close'));
    }
  };
  window.__RealWS = RealWS;
`;

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

const CHAT = '/app/dev-harness.html?chat=thread_manager';

// A long dictation is drawn in the input itself. The box must grow with it (up
// to its cap, then scroll inside itself) so the text never spills past it onto
// the toolbar.
test('composer grows with a long live dictation', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.addInitScript(BOOT);
  await stubVoiceRoutes(page);
  await page.goto(`${CHAT}&ws=fake`);
  const input = page.getByTestId('composer-input');
  await input.click();
  await tapMic(page.getByTestId('voice-note-btn'));
  await expect(input).toHaveValue(/word39/);
  const m = await page.evaluate(() => {
    const i = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    const row = i.closest('.composer-row')!;
    const toolbar = row.querySelector('.composer-actions, .composer-toolbar') as HTMLElement | null;
    return {
      inputH: i.offsetHeight,
      cap: Math.round(window.innerHeight * 0.3),
      scroll: i.scrollHeight,
      client: i.clientHeight,
      inputBottom: i.getBoundingClientRect().bottom,
      toolbarTop: toolbar ? toolbar.getBoundingClientRect().top : null,
    };
  });
  // Fits entirely, or is at the cap and scrolls inside itself.
  expect(m.inputH >= m.cap - 1 || m.scroll <= m.client).toBe(true);
  expect(m.inputH).toBeGreaterThan(60);
  if (m.toolbarTop !== null) expect(m.inputBottom).toBeLessThanOrEqual(m.toolbarTop + 1);
});
