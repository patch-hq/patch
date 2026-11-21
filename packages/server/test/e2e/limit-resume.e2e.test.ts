// e2e: chats parked on a limit all start within seconds of credit returning,
// through the REAL server and host (decision 25; the 20 Nov resume-line bug).
//
// Six chats were parked on one account at 19:39; credit returned at 20:30 and
// the host released them, but its resume line started each only once the one in
// front had FINISHED its turn, so they ran one after another for 80 minutes and
// the last read "paused" long after its account had credit. Here three chats are
// refused by the provider and parked; when credit returns every one is running
// within seconds while the first is still in its long turn, as the server's own
// status shows a surface.

import { describe, it, expect, afterEach } from 'vitest';
import type { SdkEnvelope } from '../../../host/src/sdkBackend.js';
import { TurnFailedError } from '../../../host/src/sdkBackend.js';
import { startHarness, until, type E2EHarness } from './harness.js';

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

describe('e2e: released turns after a limit', () => {
  it('three parked chats are all running within seconds while the first runs a long turn', async () => {
    // Every released turn stays open until `finish`: long agent turns.
    const provider = { limited: true, hold: undefined as Promise<void> | undefined };
    const started: string[] = [];
    h = await startHarness({
      wrapSdk: (mock) => ({
        run: (opts) => {
          started.push(opts.prompt);
          if (provider.limited) {
            return (async function* (): AsyncGenerator<SdkEnvelope> {
              throw new TurnFailedError(
                "Claude Code returned an error result: You've hit your session limit",
                {
                  kind: 'rate_limit',
                  status: 'rejected',
                  resetsAt: Date.now() + 3_600_000,
                },
              );
            })();
          }
          const hold = provider.hold;
          return (async function* (): AsyncGenerator<SdkEnvelope> {
            yield { type: 'assistant', content: `working on ${opts.prompt}`, raw: {} };
            if (hold) await hold;
            for await (const e of mock.run(opts)) if (e.type === 'result') yield e;
          })();
        },
      }),
    });
    h.daemon.setLimitBehaviour('other_account');
    const jwt = await h.mintSurface('srf-limit-resume');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await h.built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { hostId: h.hostId, folder: h.folder },
      });
      expect(res.statusCode).toBe(202);
      ids.push((res.json() as { chatId: string }).chatId);
    }
    const status = (id: string) => h!.built.chatRegistry.get(id)?.chatStatus?.state;
    for (const [i, id] of ids.entries()) {
      for (let k = 0; k < 50 && !h.daemon.chatState.get(id); k++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await h.daemon.sendInput({ chatId: id, message: `chat-${i}` });
    }
    await until(() => ids.every((id) => status(id) === 'paused'), 5000, 'all three paused');

    // Credit returns. Each released turn runs for a long time.
    let finish!: () => void;
    provider.hold = new Promise<void>((r) => (finish = r));
    provider.limited = false;
    started.length = 0;
    const t0 = Date.now();
    expect(h.daemon.resumeAllRateLimited()).toBe(3);
    await until(() => ids.every((id) => status(id) === 'running'), 5000, 'all three running');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(started).toEqual(['chat-0', 'chat-1', 'chat-2']);
    // None waited for the turn in front of it to finish: all three are in their turns at once.
    expect(ids.map(status)).toEqual(['running', 'running', 'running']);

    finish();
    await until(() => ids.every((id) => status(id) === 'idle'), 5000, 'the turns finish');
  }, 40_000);
});
