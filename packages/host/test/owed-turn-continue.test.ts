// An owed turn is never handed to the provider twice (plan decision 22).
//
// 20 Nov 2026: a patch_agent result arrived in a chat as a turn, the agent
// worked on it for twenty minutes, the turn hit a usage limit, and when credit
// came back the host re-sent the ORIGINAL message into the same session. The
// model said "That's the same fourth-review message again." Every path that
// sends an owed turn again now asks one question: does the session the turn
// resumes already hold it? If so it continues with a short visible message.
// If not, the original is delivered to the provider once more, and the record
// does not take it again. Either way the chat shows the original once.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { continueOwedTurnMessage, Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend, SdkEnvelope, SdkRunOptions } from '../src/sdkBackend.js';
import { limitError } from './limitErrors.js';

const silent = pino({ level: 'silent' });
const NOW = Date.UTC(2023, 10, 14, 12, 0, 0);
const RESETS_AT = NOW + 3_600_000;
const SPEND_LIMIT =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'raise it at claude.ai/settings/usage?from=cc_cli_limit_message';
const PROMPT = 'fourth review: check the migration';

/** What each run does: its envelopes, then how it ends. */
type Script = { out: SdkEnvelope[]; end: 'ok' | 'limit' | 'error' | 'lost' | 'hang' };

function setup(scripts: Script[]) {
  const home = mkdtempSync(join(tmpdir(), 'patch-owed-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-owed-f-')));
  const runs: SdkRunOptions[] = [];
  const events: WireEvent[] = [];
  const backend: SdkBackend = {
    run: (opts): AsyncGenerator<SdkEnvelope> => {
      runs.push(opts);
      const script = scripts.shift() ?? { out: [], end: 'ok' };
      async function* gen(): AsyncGenerator<SdkEnvelope> {
        await new Promise((r) => setTimeout(r, 2));
        for (const env of script.out) yield env;
        if (script.end === 'limit') throw limitError(SPEND_LIMIT, { resetsAt: RESETS_AT });
        if (script.end === 'error') throw new Error('socket hang up');
        if (script.end === 'lost') throw new Error('No conversation found with session ID: sess-1');
        yield {
          type: 'assistant',
          content: 'done',
          sessionId: 'sess-1',
          nativeId: 'u-done',
          raw: {},
        };
        yield { type: 'result', sessionId: 'sess-1', content: 'done', raw: {} };
      }
      return gen();
    },
  };
  let clock = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend,
    resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
    emit: (e) => events.push(e),
    logger: silent,
    now: () => NOW + clock++,
    generateChatId: () => 'chat-1',
    nextAccountAfterExhausted: () => undefined,
  });
  daemon.setLimitBehaviour('other_account');
  return { daemon, runs, events, folder };
}

/** A first turn that ran and gave the chat its session. */
const FIRST: Script = {
  out: [{ type: 'assistant', content: 'hello', sessionId: 'sess-1', nativeId: 'u-hello', raw: {} }],
  end: 'ok',
};
/** The owed turn, cut off after the provider took it and worked on it. */
const CUT_MID_TURN: Script = {
  out: [
    { type: 'assistant', content: 'Reviewing…', sessionId: 'sess-1', nativeId: 'u-a1', raw: {} },
    {
      type: 'tool_use',
      tool: { name: 'Read', args: { path: 'm.sql' }, callId: 'c1' },
      sessionId: 'sess-1',
      nativeId: 'u-t1',
      raw: {},
    },
  ],
  end: 'limit',
};
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
/** Everything the provider was handed for this chat, in order. */
const sentToModel = (runs: SdkRunOptions[]): string[] => runs.map((r) => r.prompt);
/** The user entries the chat's record took, in order. */
const recorded = (events: WireEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'chat.message' && e.role === 'user' ? [e.content] : []));

afterEach(() => {
  vi.useRealTimers();
});

async function cutTurn(scripts: Script[]) {
  const t = setup(scripts);
  const chatId = await t.daemon.spawnChat({ folder: t.folder });
  await t.daemon.sendInput({ chatId, message: 'hi', localId: 'l1' });
  await t.daemon.sendInput({ chatId, message: PROMPT, localId: 'l2' });
  return { ...t, chatId };
}

describe('an owed turn resumed after a usage limit', () => {
  it('continues with one visible message when the provider already took it', async () => {
    const { daemon, runs, events } = await cutTurn([FIRST, CUT_MID_TURN, { out: [], end: 'ok' }]);
    await settle();
    expect(daemon.resumeAllRateLimited()).toBe(1);
    await settle();

    const continued = continueOwedTurnMessage('limit');
    expect(sentToModel(runs)).toEqual(['hi', PROMPT, continued]);
    expect(runs[2]?.resumeSessionId).toBe('sess-1');
    // The record: the original once, then the continue message as one new entry.
    expect(recorded(events)).toEqual(['hi', PROMPT, continued]);
    const last = events.filter((e) => e.type === 'chat.message' && e.role === 'user').at(-1);
    expect(last).not.toHaveProperty('retryOfSeq');
    daemon.shutdown();
  });

  it('delivers the original once more when the provider refused it before taking it, without recording it again', async () => {
    const { daemon, runs, events } = await cutTurn([
      FIRST,
      { out: [], end: 'limit' },
      { out: [], end: 'ok' },
    ]);
    await settle();
    daemon.resumeAllRateLimited();
    await settle();

    expect(sentToModel(runs)).toEqual(['hi', PROMPT, PROMPT]);
    expect(recorded(events)).toEqual(['hi', PROMPT]);
    daemon.shutdown();
  });

  it('a continue that lands on a session the provider has lost gives the fresh one the original, still recorded once', async () => {
    const { daemon, runs, events } = await cutTurn([
      FIRST,
      CUT_MID_TURN,
      { out: [], end: 'lost' },
      { out: [], end: 'ok' },
    ]);
    await settle();
    daemon.resumeAllRateLimited();
    await settle(500);

    expect(sentToModel(runs)).toEqual(['hi', PROMPT, continueOwedTurnMessage('limit'), PROMPT]);
    expect(runs[3]?.resumeSessionId).toBeUndefined();
    expect(recorded(events).filter((c) => c === PROMPT)).toHaveLength(1);
    daemon.shutdown();
  });
});

describe('an owed turn retried after a transient error', () => {
  it('continues when the provider had already worked on it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { daemon, runs, events } = await cutTurn([
      FIRST,
      { out: CUT_MID_TURN.out, end: 'error' },
      { out: [], end: 'ok' },
    ]);
    await vi.advanceTimersByTimeAsync(15_000);

    const continued = continueOwedTurnMessage('error');
    expect(sentToModel(runs)).toEqual(['hi', PROMPT, continued]);
    expect(recorded(events)).toEqual(['hi', PROMPT, continued]);
    daemon.shutdown();
  });

  it('delivers the original once more when it failed before the provider produced anything', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { daemon, runs, events } = await cutTurn([
      FIRST,
      { out: [], end: 'error' },
      { out: [], end: 'ok' },
    ]);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(sentToModel(runs)).toEqual(['hi', PROMPT, PROMPT]);
    expect(recorded(events)).toEqual(['hi', PROMPT]);
    daemon.shutdown();
  });
});

describe('an owed turn after a host restart', () => {
  /** Two hosts on one home: the one that stopped, and the one that starts after it. */
  function hostsOn(home: string, scripts: Script[]) {
    const runs: SdkRunOptions[] = [];
    const events: WireEvent[] = [];
    const make = () => {
      let clock = 0;
      return new Daemon({
        hostId: 'd1',
        metaStore: createMetaStore(home),
        sdkBackend: {
          run: (opts): AsyncGenerator<SdkEnvelope> => {
            runs.push(opts);
            const script = scripts.shift() ?? { out: [], end: 'ok' };
            async function* gen(): AsyncGenerator<SdkEnvelope> {
              await new Promise((r) => setTimeout(r, 2));
              for (const env of script.out) yield env;
              if (script.end === 'error') throw new Error('socket hang up');
              if (script.end === 'hang') await new Promise(() => {});
              yield { type: 'result', sessionId: 'sess-1', content: 'done', raw: {} };
            }
            return gen();
          },
        },
        resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
        emit: (e) => events.push(e),
        logger: silent,
        now: () => NOW + 1_000_000 + clock++,
        generateChatId: () => 'chat-1',
      });
    };
    return { runs, events, make };
  }

  it('a turn waiting on its retry continues on the new host when the provider had worked on it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-owed-restart-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-owed-restart-f-')));
    const { runs, events, make } = hostsOn(home, [
      FIRST,
      { out: CUT_MID_TURN.out, end: 'error' },
      { out: [], end: 'ok' },
    ]);
    const first = make();
    const chatId = await first.spawnChat({ folder });
    await first.sendInput({ chatId, message: 'hi', localId: 'l1' });
    await first.sendInput({ chatId, message: PROMPT, localId: 'l2' });
    // The host stops before the 10 s retry fires.
    first.shutdown();

    const second = make();
    second.hydrate();
    await settle(400);

    const continued = continueOwedTurnMessage('restart');
    expect(sentToModel(runs)).toEqual(['hi', PROMPT, continued]);
    expect(recorded(events).filter((c) => c === PROMPT)).toHaveLength(1);
    expect(recorded(events).at(-1)).toBe(continued);
    void chatId;
    second.shutdown();
  });

  it('a turn the restart cut off is not sent again: the chat is left Interrupted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-owed-cut-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-owed-cut-f-')));
    const { runs, events, make } = hostsOn(home, [FIRST, { out: CUT_MID_TURN.out, end: 'hang' }]);
    const first = make();
    const chatId = await first.spawnChat({ folder });
    await first.sendInput({ chatId, message: 'hi', localId: 'l1' });
    void first.sendInput({ chatId, message: PROMPT, localId: 'l2' });
    await settle(100);
    first.shutdown();

    const second = make();
    second.hydrate();
    await settle(300);

    expect(sentToModel(runs)).toEqual(['hi', PROMPT]);
    expect(recorded(events).filter((c) => c === PROMPT)).toHaveLength(1);
    void chatId;
    second.shutdown();
  });
});
