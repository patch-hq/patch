// e2e: a chat parked on a limit across a REAL host restart (the 20 Nov self-update
// on the Mac). The server reads it paused before, during and after the restart,
// never idle while the host owes its turn; and once released it runs.

import { describe, it, expect, afterEach } from 'vitest';
import type { WireEvent } from '@patch/wire';
import type { SdkEnvelope } from '../../../host/src/sdkBackend.js';
import { TurnFailedError } from '../../../host/src/sdkBackend.js';
import { startHarness, record, until, type E2EHarness } from './harness.js';

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

describe('e2e: a parked chat across a host restart', () => {
  it('reads paused through the restart, never idle, and runs once released', async () => {
    const provider = { limited: true, ran: [] as string[] };
    const resetsAt = Date.now() + 3_600_000;
    h = await startHarness({
      wrapSdk: (mock) => ({
        run: (opts) => {
          provider.ran.push(opts.prompt);
          if (provider.limited) {
            return (async function* (): AsyncGenerator<SdkEnvelope> {
              throw new TurnFailedError(
                "Claude Code returned an error result: You've hit your session limit",
                { kind: 'rate_limit', status: 'rejected', resetsAt },
              );
            })();
          }
          return mock.run(opts);
        },
      }),
    });
    h.daemon.setLimitBehaviour('other_account');
    const jwt = await h.mintSurface('srf-restored-park');
    const client = await h.connectSurface('srf-restored-park-ws');
    const res = await h.built.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { hostId: h.hostId, folder: h.folder },
    });
    expect(res.statusCode).toBe(202);
    const chatId = (res.json() as { chatId: string }).chatId;
    const status = () => h!.built.chatRegistry.get(chatId)?.chatStatus?.state;
    for (let k = 0; k < 50 && !h.daemon.chatState.get(chatId); k++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await h.daemon.sendInput({ chatId, message: 'the owed turn' });
    await until(() => status() === 'paused', 5000, 'paused');
    expect(h.built.chatRegistry.get(chatId)?.chatStatus?.resetsAt).toBe(resetsAt);

    // What every surface is told about the chat from here on.
    client.send({ type: 'chat.focus_change', chatId });
    const frames = record(client, ['chat.state']);
    const told = (): string[] =>
      frames
        .filter((e): e is Extract<WireEvent, { type: 'chat.state' }> => e.type === 'chat.state')
        .filter((e) => e.chatId === chatId)
        .map((e) => e.chatStatus?.state ?? '?');

    // Frames about the turn that parked the chat can still be in flight when the
    // recorder starts (or none may come at all); let them land, then only what
    // the surface is told from the restart on counts.
    await new Promise((r) => setTimeout(r, 500));
    const before = told().length;

    // The host self-updates: a new host on the same ~/.patch.
    await h.restartHost();
    h.daemon.setLimitBehaviour('other_account');
    // The new host announces the chat with the same hold.
    await new Promise((r) => setTimeout(r, 500));
    expect(status()).toBe('paused');
    expect(h.built.chatRegistry.get(chatId)?.chatStatus?.resetsAt).toBe(resetsAt);
    expect(told().slice(before), `frames told: ${told().join(',')} (restart at ${before})`).not.toContain(
      'idle',
    );

    // The accounts are known and one has credit: the park is released.
    provider.limited = false;
    provider.ran.length = 0;
    expect(h.daemon.releaseRestoredParks().released).toEqual([chatId]);
    await until(() => provider.ran.length > 0, 5000, 'the owed turn runs');
    expect(provider.ran).toEqual(['the owed turn']);
    await until(() => status() === 'idle', 5000, 'the turn finishes');
    await client.close();
  }, 40_000);
});
