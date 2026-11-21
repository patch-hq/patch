// A turn parked on a limit, carried across a host restart (spec/10 § Limits,
// spec/12 § Limits and sign-in).
//
// 20 Nov 2026, the Mac. A chat parked at 19:39 (limitNext other_account) was
// still parked when the host self-updated at 23:02, though its account had had
// credit since 20:30. The restart put the park back but armed nothing, so only a
// usage reading could have woken it, and none came; and the host's frames no
// longer carried the limit, so the server read the chat as idle while the host
// still owed its turn.
//
// A restored park now reports the same hold as a live one (`limitHold`), and
// once the accounts are known it is released straight away when it may run, or
// its reset re-armed when that is still ahead.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';
import { limitError } from './limitErrors.js';

const silent = pino({ level: 'silent' });
const LIMIT = "Claude Code returned an error result: You've hit your session limit";

interface Provider {
  limited: boolean;
  ran: string[];
}

function backend(p: Provider): SdkBackend {
  return {
    run: (opts): AsyncGenerator<SdkEnvelope> =>
      (async function* () {
        p.ran.push(opts.prompt);
        if (p.limited) throw limitError(LIMIT, { resetsAt: Date.now() + 3_600_000 });
        yield { type: 'assistant', content: 'done', raw: {} };
        yield { type: 'result', sessionId: 's-1', content: 'done', raw: {} };
      })(),
  };
}

function host(
  home: string,
  p: Provider,
  opts: {
    outOfCredit?: () => boolean;
    resetsAt?: () => number | undefined;
    behaviour?: 'other_account' | 'switch_provider';
  } = {},
) {
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend(p),
    resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'work' }),
    emit: (e) => events.push(e),
    logger: silent,
    generateChatId: () => 'chat-parked',
    nextAccountAfterExhausted: () => undefined,
    hostOutOfCredit: opts.outOfCredit ?? (() => true),
    accountLimitInfo: () => ({
      label: 'work',
      scope: 'session',
      ...(opts.resetsAt?.() !== undefined ? { resetsAt: opts.resetsAt()! } : {}),
    }),
  });
  daemon.setLimitBehaviour(opts.behaviour ?? 'other_account');
  const lastState = () =>
    events
      .filter((e): e is Extract<WireEvent, { type: 'chat.state' }> => e.type === 'chat.state')
      .at(-1);
  return { daemon, events, lastState };
}

const until = async (done: () => boolean, ms = 3000): Promise<void> => {
  for (let i = 0; i < ms / 20 && !done(); i++) await new Promise((r) => setTimeout(r, 20));
};

/** Park a chat on a limit whose reset is `resetsAt`, then stop that host. */
async function parkThenRestart(
  resetsAt: number,
  behaviour: 'other_account' | 'switch_provider' = 'other_account',
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-restored-park-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-restored-park-f-')));
  const p: Provider = { limited: true, ran: [] };
  const first = host(home, p, { resetsAt: () => resetsAt, behaviour });
  const chatId = await first.daemon.spawnChat({ folder });
  await first.daemon.sendInput({ chatId, message: 'the owed turn', localId: 'l1' });
  expect(first.lastState()?.limitHold).toMatchObject({
    accountId: 'work',
    scope: 'session',
    resetsAt,
  });
  first.daemon.shutdown();
  p.ran.length = 0;
  return { home, chatId, p };
}

describe('a park carried across a restart', () => {
  it('reports the same hold after the restart as before it', async () => {
    const resetsAt = Date.now() + 3_600_000;
    const { home, chatId, p } = await parkThenRestart(resetsAt);
    const second = host(home, p);
    second.daemon.hydrate();
    // What the host says of the chat when it announces it to the server.
    (second.daemon as unknown as { emitState(id: string): void }).emitState(chatId);
    const st = second.lastState();
    expect(st?.limitNext).toBe('other_account');
    expect(st?.limitHold).toMatchObject({ accountId: 'work', scope: 'session', resetsAt });
    second.daemon.shutdown();
  });

  it('is released within seconds when an account it may use has credit', async () => {
    const { home, chatId, p } = await parkThenRestart(Date.now() + 3_600_000);
    p.limited = false;
    const second = host(home, p, { outOfCredit: () => false });
    second.daemon.hydrate();
    // Nothing runs on its own before the accounts are known.
    await new Promise((r) => setTimeout(r, 100));
    expect(p.ran).toEqual([]);
    const t0 = Date.now();
    expect(second.daemon.releaseRestoredParks()).toEqual({ released: [chatId], armed: [] });
    await until(() => p.ran.length > 0);
    expect(p.ran).toEqual(['the owed turn']);
    expect(Date.now() - t0).toBeLessThan(3000);
    await until(() => second.lastState()?.limitHold === null);
    expect(second.lastState()?.limitHold).toBeNull();
    second.daemon.shutdown();
  });

  it('is released when its stated reset has already passed, credit or not', async () => {
    const { home, chatId, p } = await parkThenRestart(Date.now() + 200);
    await new Promise((r) => setTimeout(r, 300));
    p.limited = false;
    const second = host(home, p, { outOfCredit: () => true });
    second.daemon.hydrate();
    expect(second.daemon.releaseRestoredParks().released).toEqual([chatId]);
    await until(() => p.ran.length > 0);
    expect(p.ran).toEqual(['the owed turn']);
    second.daemon.shutdown();
  });

  it('with no credit and its reset ahead, re-arms the reset and is released at it', async () => {
    const resetsAt = Date.now() + 600;
    const { home, chatId, p } = await parkThenRestart(resetsAt);
    p.limited = false;
    const second = host(home, p, { outOfCredit: () => true });
    second.daemon.hydrate();
    expect(second.daemon.releaseRestoredParks()).toEqual({ released: [], armed: [chatId] });
    // The re-armed reset is what the chat says it resumes at.
    expect(second.lastState()?.rateLimitResumingAt).toBe(resetsAt);
    await new Promise((r) => setTimeout(r, 200));
    expect(p.ran).toEqual([]);
    await until(() => p.ran.length > 0, 3000);
    expect(p.ran).toEqual(['the owed turn']);
    second.daemon.shutdown();
  });

  it('a park waiting for the user is left for the user', async () => {
    const { home, p } = await parkThenRestart(Date.now() + 3_600_000, 'switch_provider');
    const second = host(home, p, { outOfCredit: () => false, behaviour: 'other_account' });
    second.daemon.hydrate();
    // Recorded as waiting for a provider switch when it parked: a restart and a
    // changed setting do not make it run on its own.
    expect(second.daemon.releaseRestoredParks()).toEqual({ released: [], armed: [] });
    await new Promise((r) => setTimeout(r, 100));
    expect(p.ran).toEqual([]);
    second.daemon.shutdown();
  });
});
