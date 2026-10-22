// Acceptance tests for the budgeted provider-switch handoff, wired through
// Daemon (spec/04 § Provider switches — Handoff budget). The planning core is
// covered in handoffPlan.test.ts; these pin the end-to-end behaviour of the
// wiring: window from the model limits, ledger and recent window, persisted
// handoff state, one overflow re-plan, verification and recovery. Mocks follow
// provider-switch-native-cache.test.ts.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import {
  createMockSdkBackend,
  HandoffOverflowError,
  type SdkBackend,
  type SdkEnvelope,
  type SdkRunOptions,
} from '../src/sdkBackend.js';
import { isCodexModel } from '../src/codexAccounts.js';
import { ModelLimits } from '../src/handoffRun.js';
import { estimateTokens } from '../src/nativeReconstruct.js';
import { availableInputTokens } from '../src/handoffPlan.js';

const silent = pino({ level: 'silent' });
const CLAUDE_MODEL = 'claude-opus-5';
const CODEX_MODEL = 'openai/mock-codex';
/** Small enough that a few dozen 4k-char turns cannot fit it whole. */
const TARGET_WINDOW = 60_000;
const TARGET_OUTPUT = 4_000;
const REPORTED_INPUT_TOKENS = 4321;

interface CodexScript {
  /** How many leading calls are refused as over the window, before any output. */
  overflows?: number;
  /** Every call is refused outright (a non-overflow failure). */
  alwaysFail?: boolean;
}

/** A Codex-shaped mock that records every request and can refuse the first N as too large. */
function createScriptedCodex(script: CodexScript) {
  const calls: SdkRunOptions[] = [];
  let toolsRun = 0;
  let counter = 0;
  const backend: SdkBackend = {
    async *run(opts: SdkRunOptions): AsyncGenerator<SdkEnvelope> {
      calls.push({ ...opts });
      if (script.alwaysFail) throw new Error('codex is down');
      if (calls.length <= (script.overflows ?? 0))
        throw new HandoffOverflowError('context_length_exceeded', undefined);
      const prior = opts.resumeSessionId?.startsWith('codex-') ? opts.resumeSessionId : undefined;
      const sessionId = prior ?? `codex-${++counter}`;
      yield { type: 'system', sessionId };
      yield { type: 'system', tokenUsage: { inputTokens: REPORTED_INPUT_TOKENS } };
      yield { type: 'assistant', content: `codex reply to: ${opts.prompt.slice(0, 40)}` };
      yield { type: 'result', sessionId };
    },
  };
  return { backend, calls, toolsRun: () => toolsRun };
}

function setup(
  o: {
    codex?: CodexScript;
    window?: number;
    generateDigest?: () => Promise<string | null>;
    home?: string;
  } = {},
) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'patch-handoff-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-handoff-folder-'));
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-handoff-projects-'));
  const mockClaude = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
  const codex = createScriptedCodex(o.codex ?? {});
  const known = new Set<string>();
  const routed: SdkBackend = {
    run: (opts) => {
      if (!isCodexModel(opts.model)) return mockClaude.run(opts);
      return (async function* () {
        for await (const env of codex.backend.run(opts)) {
          if (env.sessionId) known.add(env.sessionId);
          yield env;
        }
      })();
    },
  };
  const claudeHistory = createHistoryReader({ claudeProjectsRoot: projectsRoot });
  const historyReader = {
    hasSession: (x: { folder: string; sessionId: string }) =>
      x.sessionId.startsWith('codex-') ? known.has(x.sessionId) : claudeHistory.hasSession(x),
    read: (x: Parameters<typeof claudeHistory.read>[0]) => claudeHistory.read(x),
    forkPoint: (x: Parameters<typeof claudeHistory.forkPoint>[0]) => claudeHistory.forkPoint(x),
    sidePoint: (x: Parameters<typeof claudeHistory.sidePoint>[0]) => claudeHistory.sidePoint(x),
  };
  const limits = new ModelLimits();
  limits.note(CODEX_MODEL, {
    contextWindow: o.window ?? TARGET_WINDOW,
    maxOutputTokens: TARGET_OUTPUT,
  });
  const events: WireEvent[] = [];
  const metaStore = createMetaStore(home);
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: routed,
    historyReader,
    claudeProjectsRoot: projectsRoot,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    modelLimits: limits,
    ...(o.generateDigest ? { generateDigest: o.generateDigest } : {}),
  });
  return {
    daemon,
    codex,
    mockClaude,
    events,
    folder,
    metaStore,
    home,
    limits,
    projectsRoot,
    known,
  };
}

/** A chat on Claude with `turns` long exchanges — far more than the target takes. */
async function longChat(s: ReturnType<typeof setup>, turns = 40): Promise<string> {
  const chatId = await s.daemon.spawnChat({ folder: s.folder, model: CLAUDE_MODEL });
  for (let i = 0; i < turns; i++) {
    await s.daemon.sendInput({
      chatId,
      message: `turn ${i} ${'lorem ipsum '.repeat(350)}`,
      localId: `l${i}`,
    });
  }
  return chatId;
}

const LATEST = '  Do the thing — exactly as written,\n\twith "odd" whitespace ☃  ';

function logBytes(home: string, chatId: string): string {
  return readFileSync(join(home, 'chats', chatId, 'events.jsonl'), 'utf8');
}

function logRecords(home: string, chatId: string): Record<string, unknown>[] {
  return logBytes(home, chatId)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function chatErrors(events: WireEvent[]) {
  return events.filter(
    (e): e is Extract<WireEvent, { type: 'chat.error' }> => e.type === 'chat.error',
  );
}

function dividers(events: WireEvent[]) {
  return events.filter(
    (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
      e.type === 'chat.message' && e.sessionChange?.handoff !== undefined,
  );
}

async function switchAndSend(s: ReturnType<typeof setup>, chatId: string, localId = 'sw') {
  await s.daemon.setChatModel(chatId, CODEX_MODEL);
  await s.daemon.sendInput({ chatId, message: LATEST, localId });
}

describe('long cross-provider handoff (Claude long chat → small-window target)', () => {
  it('first request sent to the target is under its available input; no context_length_exceeded', async () => {
    const s = setup();
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);

    expect(s.codex.calls).toHaveLength(1);
    const call = s.codex.calls[0]!;
    const available = availableInputTokens({
      contextWindow: TARGET_WINDOW,
      instructionsTokens: 0,
      toolsTokens: 0,
      outputTokens: TARGET_OUTPUT,
    });
    // Whole-track reconstruction would be far past the window…
    const whole = (await s.daemon.estimateProviderSwitch(chatId, CLAUDE_MODEL)) ?? null;
    void whole;
    expect(estimateTokens(call.codexReseed!.events) * 1.25).toBeLessThan(available);
    expect(call.codexReseed!.events.length).toBeLessThan(40 * 2);
    expect(call.handoffStrict).toBe(true);
    expect(chatErrors(s.events)).toHaveLength(0);
  });

  it('the latest user message reaches the target byte-identical as the turn input', async () => {
    const s = setup();
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    expect(s.codex.calls[0]!.prompt).toBe(LATEST);
  });

  it('the target request carries the ledger block naming the chat id and omitted seq range', async () => {
    const s = setup();
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    const seeded = s.codex.calls[0]!.codexReseed!.events;
    const first = seeded[0]!;
    expect(first.event.type).toBe('chat.message');
    const text = (first.event as { content: string }).content;
    expect(text).toContain(`chat ${chatId}`);
    expect(text).toContain('patch_history');
    const range = /seq (-?\d+)–(-?\d+)/.exec(text);
    expect(range).not.toBeNull();
    // The omitted range ends right before the first verbatim entry that follows the ledger.
    expect(Number(range![2])).toBe(seeded[1]!.record.seq - 1);
  });

  it('the target can read an omitted seq range through patch_history without replay', async () => {
    const s = setup();
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    const text = (s.codex.calls[0]!.codexReseed!.events[0]!.event as { content: string }).content;
    const [, from, to] = /seq (-?\d+)–(-?\d+)/.exec(text)!.map(Number) as [number, number, number];
    const page = s.daemon.readHistory({ chatId, fromSeq: Math.max(0, from), limit: 5 });
    expect(page.events.length).toBeGreaterThan(0);
    const seqs = page.events.map((e) => (e as { seq: number }).seq);
    expect(Math.min(...seqs)).toBeGreaterThanOrEqual(Math.max(0, from));
    expect(Math.max(...seqs)).toBeLessThanOrEqual(to);
  });

  it('events.jsonl is byte-identical before and after the switch except appended records', async () => {
    const s = setup();
    const chatId = await longChat(s);
    const before = logBytes(s.home, chatId);
    await switchAndSend(s, chatId);
    const after = logBytes(s.home, chatId);
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('after the first target reply a handoff.verified record holds the reported input tokens and the instruction hash', async () => {
    const s = setup();
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    const verified = logRecords(s.home, chatId)
      .map((r) => r['rec'] as Record<string, unknown>)
      .filter((r) => r['k'] === 'handoff.verified');
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({
      replyReceived: true,
      reportedInputTokens: REPORTED_INPUT_TOKENS,
      instructionHash: createHash('sha256').update(LATEST, 'utf8').digest('hex'),
    });
    expect(typeof verified[0]!['flagged']).toBe('boolean');
    expect(s.metaStore.read(chatId)!.handoff!.state).toBe('confirmed');
  });

  it('the transcript divider shows carried vs omitted counts', async () => {
    const s = setup();
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    const [divider] = dividers(s.events);
    const h = divider!.sessionChange!.handoff!;
    expect(h.carriedEntries).toBeLessThan(h.totalEntries);
    expect(h.omittedFromSeq).toBeDefined();
    expect(divider!.content).toContain(
      `carried ${h.carriedEntries.toLocaleString('en-GB')} of ${h.totalEntries.toLocaleString('en-GB')}`,
    );
    expect(divider!.content).toContain('older history readable on demand');
  });
});

describe('source provider unavailable or rate limited', () => {
  const down = () => Promise.reject(new Error('claude is rate limited'));

  it('Claude backend errors on every call: the switch still completes from the deterministic ledger', async () => {
    const s = setup({ generateDigest: down });
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    expect(chatErrors(s.events)).toHaveLength(0);
    expect(s.codex.calls).toHaveLength(1);
    expect(s.metaStore.read(chatId)!.claudeSessionId).toMatch(/^codex-/);
  });

  it('the divider states that no model-written summary was available, and why', async () => {
    const s = setup({ generateDigest: down });
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    const [divider] = dividers(s.events);
    expect(divider!.sessionChange!.handoff!.summary).toBe(false);
    expect(divider!.sessionChange!.handoff!.summaryNote).toContain('claude is rate limited');
    expect(divider!.content).toContain('no model-written summary');
  });

  it('an explicit compact-with-summary switch with the source down fails loudly with no session change', async () => {
    const s = setup({ generateDigest: () => Promise.resolve(null) });
    const chatId = await longChat(s, 3);
    const before = s.metaStore.read(chatId)!.claudeSessionId;
    await s.daemon.setChatModel(chatId, CODEX_MODEL, { compact: true });
    await s.daemon.sendInput({ chatId, message: 'go', localId: 'c1' });
    expect(chatErrors(s.events).map((e) => e.error.code)).toContain('switch_compact_failed');
    expect(s.codex.calls).toHaveLength(0);
    expect(s.metaStore.read(chatId)!.claudeSessionId).toBe(before);
  });
});

describe('oversized first request and retry', () => {
  it('target window smaller than ledger + instruction: fails before any request, history untouched, chat stays on the source model', async () => {
    const s = setup({ window: 20_000 });
    const chatId = await longChat(s);
    const before = logBytes(s.home, chatId);
    await switchAndSend(s, chatId);
    expect(s.codex.calls).toHaveLength(0);
    expect(chatErrors(s.events).map((e) => e.error.code)).toEqual(['handoff_too_large']);
    expect(s.metaStore.read(chatId)!.model).toBe(CLAUDE_MODEL);
    expect(s.metaStore.read(chatId)!.claudeSessionId).not.toMatch(/^codex-/);
    // The user's message was logged; nothing else about the chat's past changed.
    expect(logBytes(s.home, chatId).startsWith(before)).toBe(true);
  });

  it('a 400 context_length_exceeded triggers exactly one tighter re-plan, not a resend of the same request', async () => {
    const s = setup({ codex: { overflows: 1 } });
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    expect(s.codex.calls).toHaveLength(2);
    const [first, second] = s.codex.calls.map((c) => estimateTokens(c.codexReseed!.events));
    expect(second!).toBeLessThan(first! / 2);
    expect(s.codex.calls[1]!.prompt).toBe(LATEST);
    expect(chatErrors(s.events)).toHaveLength(0);
    const divider = dividers(s.events).at(-1)!;
    expect(divider.sessionChange!.handoff!.replanned).toBe(true);
    expect(s.metaStore.read(chatId)!.handoff!.replanned).toBe(true);
  });

  it('two consecutive overflows end in a visible error offering retry, switch back, and linked fresh chat', async () => {
    const s = setup({ codex: { overflows: 2 } });
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    expect(s.codex.calls).toHaveLength(2);
    expect(chatErrors(s.events).map((e) => e.error.code)).toEqual(['handoff_overflow']);
    const handoff = s.metaStore.read(chatId)!.handoff!;
    expect(handoff.state).toBe('planned');
    // The three recoveries all have what they need.
    expect(handoff.prompt).toBe(LATEST);
    expect(handoff.targetModel).toBe(CODEX_MODEL);
    expect(s.metaStore.read(chatId)!.switchedFrom).toEqual({ model: CLAUDE_MODEL });
  });

  it('a retried switch delivers the pending message once (same handoff key, no duplicate log record)', async () => {
    const s = setup({ codex: { overflows: 2 } });
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    const key = s.metaStore.read(chatId)!.handoff!.key;
    await s.daemon.recoverHandoff(chatId, 'retry');
    expect(s.metaStore.read(chatId)!.handoff!.key).toBe(key);
    const userRecords = logRecords(s.home, chatId).filter((r) => {
      const rec = r['rec'] as {
        k: string;
        event?: { type: string; role?: string; content?: string };
      };
      return (
        rec.k === 'event' &&
        rec.event?.type === 'chat.message' &&
        rec.event.role === 'user' &&
        rec.event.content === LATEST
      );
    });
    expect(userRecords).toHaveLength(1);
    expect(s.codex.calls.at(-1)!.prompt).toBe(LATEST);
  });

  it('no tool call executes before the target has accepted the request', async () => {
    const s = setup({ codex: { overflows: 2 } });
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    expect(s.codex.toolsRun()).toBe(0);
    expect(s.events.filter((e) => e.type === 'chat.tool_call')).toHaveLength(0);
  });
});

describe('recovery', () => {
  it('after a failed switch, switching back resumes the source session with only the delta', async () => {
    const s = setup({ codex: { overflows: 2 } });
    const chatId = await longChat(s);
    const claudeSession = s.metaStore.read(chatId)!.claudeSessionId!;
    await switchAndSend(s, chatId);
    await s.daemon.recoverHandoff(chatId, 'switch_back');
    expect(s.metaStore.read(chatId)!.model).toBe(CLAUDE_MODEL);
    await s.daemon.sendInput({ chatId, message: 'back on claude', localId: 'back' });
    const opts = s.mockClaude.lastOptions()!;
    expect(opts.resumeSessionId).toBe(claudeSession);
    expect(opts.claudeSessionStore?.reseed).toBeUndefined();
  });

  it('a linked fresh chat is seeded with the same handoff and records continuedFrom', async () => {
    const s = setup({ codex: { overflows: 2 } });
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    const before = s.codex.calls.length;
    await s.daemon.recoverHandoff(chatId, 'linked_chat');
    const link = s.events.find(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.handoffLink !== undefined,
    )!;
    const newChatId = link.handoffLink!.chatId;
    expect(newChatId).not.toBe(chatId);
    expect(s.metaStore.read(newChatId)!.continuedFrom).toEqual({ chatId });
    // The new chat's first turn went to the target carrying the ledger and the pending instruction.
    await new Promise((r) => setTimeout(r, 50));
    expect(s.codex.calls.length).toBeGreaterThan(before);
    const seed = s.codex.calls.at(-1)!.prompt;
    expect(seed).toContain(`chat ${chatId}`);
    expect(seed).toContain(LATEST);
    // The old chat is intact.
    expect(s.metaStore.read(chatId)!.model).toBe(CODEX_MODEL);
  });

  it('host restart mid-handoff resumes from the persisted planned/sent state without re-sending', async () => {
    const s = setup({ codex: { overflows: 2 } });
    const chatId = await longChat(s);
    await switchAndSend(s, chatId);
    const persisted = s.metaStore.read(chatId)!.handoff!;
    expect(persisted.state).toBe('planned');

    // A second host over the same home is a restart; the target now accepts.
    const restarted = setup({ home: s.home });
    restarted.daemon.hydrate();
    await restarted.daemon.recoverHandoff(chatId, 'retry');
    expect(restarted.codex.calls).toHaveLength(1);
    expect(restarted.metaStore.read(chatId)!.handoff!.key).toBe(persisted.key);
    expect(restarted.metaStore.read(chatId)!.handoff!.state).toBe('confirmed');
    // The pending message is in the log once, from before the restart.
    const delivered = logRecords(s.home, chatId).filter((r) => {
      const rec = r['rec'] as { k: string; event?: { role?: string; content?: string } };
      return rec.k === 'event' && rec.event?.role === 'user' && rec.event.content === LATEST;
    });
    expect(delivered).toHaveLength(1);
  });
});
