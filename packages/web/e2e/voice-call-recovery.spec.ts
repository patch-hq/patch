import { test, expect } from '@playwright/test';

// Real-browser e2e for a dropped call coming back (spec/07 § A dropped call
// comes back, § Call logs), on the web and desktop app.
//
// The host is a fake audio socket that speaks the real wire frames: it answers
// `audio.session_start` with a turn state and a heartbeat every 200 ms. The
// first session's heartbeats stop after a few, as a line that has silently
// gone dead does. The page must notice on its own (three seconds without one),
// say Reconnecting…, redial as a resumed call, and once the new session is up
// send the log of the drop. Everything above the socket is real: the voice
// controller, the shared call line, the audio session decoder and the bar.

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
    return ctx.createMediaStreamDestination().stream;
  };
  window.__audioSockets = [];
  window.__audioSessions = 0;
  window.WebSocket = class extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    binaryType = 'arraybuffer';
    constructor(url) {
      super();
      this.url = url;
      this.sent = [];
      window.__audioSockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      }, 0);
    }
    frame(f) {
      if (this.readyState !== 1) return;
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(f) }));
    }
    send(data) {
      if (typeof data !== 'string') return; // mic PCM
      const f = JSON.parse(data);
      this.sent.push(f);
      if (f.type !== 'audio.session_start') return;
      const session = window.__audioSessions++;
      // A real host answers over the network, after the page has sent this.
      setTimeout(() => this.frame({ type: 'audio.state', sessionId: f.sessionId, state: 'listening' }), 20);
      let seq = 0;
      // The first session's line goes dead after three heartbeats.
      const beats = session === 0 ? 3 : Infinity;
      this.timer = setInterval(() => {
        if (seq >= beats) return;
        this.frame({ type: 'audio.heartbeat', sessionId: f.sessionId, n: seq, rttMs: 12 });
        seq++;
      }, 200);
    }
    close() {
      clearInterval(this.timer);
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent('close'));
    }
  };
`;

test('a call whose heartbeat stops says Reconnecting…, redials, and sends the log once back', async ({
  page,
}) => {
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
  let minted = 0;
  await page.route('**/api/voice/token', (r) => {
    minted += 1;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token: 't',
        sessionId: `sess_${minted}`,
        audioUrl: `/audio/sess_${minted}`,
        expiresAt: Date.now() + 60_000,
      }),
    });
  });
  await page.goto('/app/dev-harness.html?chat=thread_manager&ws=fake&shell=1');
  await page.getByTestId('call-btn').click();
  const bar = page.getByTestId('voice-bar');
  await expect(bar).toHaveAttribute('data-state', 'listening');

  // The heartbeats stop; three seconds later the page calls the line lost.
  await expect(bar).toHaveAttribute('data-state', 'reconnecting', { timeout: 6_000 });
  await expect(page.getByTestId('voice-bar-connecting')).toContainText('Reconnecting');
  // …and the redial brings it back.
  await expect(bar).toHaveAttribute('data-state', 'listening', { timeout: 6_000 });

  const sockets = await page.evaluate(() =>
    (
      window as unknown as { __audioSockets: Array<{ sent: Array<Record<string, unknown>> }> }
    ).__audioSockets.map((s) => s.sent),
  );
  const audio = sockets.filter((sent) => sent[0]?.type === 'audio.session_start');
  expect(audio).toHaveLength(2);
  const [first, second] = audio as [Array<Record<string, unknown>>, Array<Record<string, unknown>>];
  // Every heartbeat was echoed.
  expect(first.filter((f) => f.type === 'audio.heartbeat').map((f) => f.n)).toEqual([0, 1, 2]);
  // The redial says it is the same call, picked back up.
  expect(second[0]).toMatchObject({ type: 'audio.session_start', resumed: true });
  // The log of the drop went on the new session.
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __audioSockets: Array<{ sent: Array<{ type: string }> }>;
            }
          ).__audioSockets
            .at(-1)!
            .sent.filter((f) => f.type === 'audio.call_log').length,
      ),
    )
    .toBe(1);
  const log = await page.evaluate(
    () =>
      (
        window as unknown as {
          __audioSockets: Array<{ sent: Array<{ type: string; entries?: unknown[] }> }>;
        }
      ).__audioSockets
        .at(-1)!
        .sent.find((f) => f.type === 'audio.call_log')!.entries,
  );
  expect(log).toEqual([
    expect.objectContaining({ kind: 'audio_stopped', sessionId: 'sess_1', reason: 'signal_lost' }),
    expect.objectContaining({
      kind: 'quality',
      sessionId: 'sess_1',
      heartbeats: 3,
      rttMs: { min: 12, avg: 12, max: 12 },
    }),
    expect.objectContaining({ kind: 'reconnected', sessionId: 'sess_2', attempts: 1 }),
  ]);
});
