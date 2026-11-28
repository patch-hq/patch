import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

// Real-browser e2e: a call keeps going with its tab in the background (spec/07
// § A call keeps going in the background), on the web and desktop app.
//
// The host is played by this test process through Playwright's WebSocket
// routing, so its heartbeats come from outside the page and keep coming while
// the page is in the background — as a real host's do. Once the call is live
// the page is put in the background as far as a call can tell: it reads as
// hidden, and every one of the page's own timers is held to firing once a
// minute, as Chrome does to a tab hidden for a few minutes (headless Chrome
// never hides a page itself). The test checks that, so throttled, the call
// still answers every heartbeat, and that when the host goes silent the page
// notices on its own, resumes the call and comes back live — which it can only
// do if nothing a call needs runs on the page's timers.

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
`;

interface FakeSession {
  sessionId: string;
  sent: Array<Record<string, unknown>>;
  /** The line drops: heartbeats stop and the socket closes (silence alone never drops a call). */
  silence(): void;
}

/** Play the host: answer session_start, then a heartbeat every 200 ms until silenced. */
async function playHost(page: Page): Promise<FakeSession[]> {
  const sessions: FakeSession[] = [];
  await page.routeWebSocket(/\/audio\//, (ws: WebSocketRoute) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const session: FakeSession = {
      sessionId: '',
      sent: [],
      silence: () => {
        clearInterval(timer);
        ws.close({ code: 1006, reason: 'line dropped' });
      },
    };
    sessions.push(session);
    ws.onMessage((data) => {
      if (typeof data !== 'string') return; // microphone PCM
      const f = JSON.parse(data) as Record<string, unknown>;
      session.sent.push(f);
      if (f.type !== 'audio.session_start') return;
      session.sessionId = f.sessionId as string;
      ws.send(JSON.stringify({ type: 'audio.state', sessionId: f.sessionId, state: 'listening' }));
      let n = 0;
      timer = setInterval(() => {
        ws.send(JSON.stringify({ type: 'audio.heartbeat', sessionId: f.sessionId, n: n++ }));
      }, 200);
    });
    ws.onClose(() => clearInterval(timer));
  });
  return sessions;
}

test('a call in a background tab answers its heartbeats, and resumes a dead line while hidden', async ({
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
  const sessions = await playHost(page);
  await page.goto('/app/dev-harness.html?chat=thread_manager&ws=fake&shell=1');
  // A call is checked before it dials (spec/07 § Readiness): the host must hold
  // the key of the voice agent the call uses (Gemini by default).
  await page.evaluate(() => {
    const store = (
      window as unknown as {
        __presenceStore: {
          getState(): {
            hosts: Record<string, { host: Record<string, unknown> | null }>;
            setHostReport(r: Record<string, unknown>): void;
          };
        };
      }
    ).__presenceStore;
    const host = store.getState().hosts['d1']!.host!;
    store.getState().setHostReport({
      ...host,
      type: 'host.host',
      voiceKeys: { gemini: true, openai: true, groq: false, deepgram: false, elevenlabs: true },
    });
  });
  await page.getByTestId('call-btn').click();
  const bar = page.getByTestId('voice-bar');
  await expect(bar).toHaveAttribute('data-state', 'listening');

  // Into the background: hidden, and the page's own timers throttled to a minute.
  await page.evaluate(() => {
    const MINUTE = 60_000;
    const realSet = window.setTimeout.bind(window);
    const realInterval = window.setInterval.bind(window);
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
      realSet(fn, Math.max(ms ?? 0, MINUTE), ...args)) as typeof window.setTimeout;
    window.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
      realInterval(fn, Math.max(ms ?? 0, MINUTE), ...args)) as typeof window.setInterval;
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // Hidden, the call answers every heartbeat.
  const echoes = (s: FakeSession): number =>
    s.sent.filter((f) => f.type === 'audio.heartbeat').length;
  const first = sessions[0]!;
  const before = echoes(first);
  await page.waitForTimeout(3_000);
  expect(echoes(first) - before).toBeGreaterThanOrEqual(10);

  // The line goes dead while hidden: the page notices and resumes the same session on its own.
  first.silence();
  await expect.poll(() => sessions.length, { timeout: 8_000 }).toBe(2);
  const second = sessions[1]!;
  await expect.poll(() => second.sent[0]?.type).toBe('audio.session_start');
  // The redial names the session it was last live on, so the host resumes it.
  expect(second.sent[0]).toMatchObject({ resumes: 'sess_1' });
  expect(await page.evaluate(() => document.visibilityState)).toBe('hidden');
  // …and the resumed line is live: its heartbeats are answered too, still hidden.
  await expect.poll(() => echoes(second), { timeout: 5_000 }).toBeGreaterThan(3);
  await expect(bar).toHaveAttribute('data-state', 'listening');
});
