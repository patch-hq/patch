// spec/07 § The fast voice and the chat's agent — a hand-off is written into the
// chat when it is made, in order with what was said around it, not when the
// agent gets to it behind work already running.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';
import { createVoiceReplyBridge } from '../src/audio/replyBridge.js';
import { createChatVoice, type ChatVoice } from '../src/audio/chatVoice.js';
import { createVoiceLedger } from '../src/audio/voiceLedger.js';

const silent = pino({ level: 'silent' });
const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

function gatedBackend() {
  const gates: Array<() => void> = [];
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
      prompts.push(opts.prompt);
      await new Promise<void>((resolve) => gates.push(resolve));
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: `reply:${opts.prompt.slice(-12)}`, sessionId: 'sess' };
    },
  };
  return { backend, prompts, releaseNext: () => gates.shift()?.() };
}

function setup(backend: SdkBackend) {
  const home = mkdtempSync(join(tmpdir(), 'patch-vho-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-vhof-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const bridge = createVoiceReplyBridge();
  let glue: ChatVoice | undefined;
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: (e) => {
      events.push(e);
      bridge.observe(e);
      glue?.observe(e);
    },
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    onDrawnTurnStarted: (chatId, localId) => {
      bridge.turnStarted(chatId, localId);
      glue?.handoffStarted({ chatId, handoffId: localId });
    },
  });
  // The voice glue, as main() wires it: it sees every event and every hand-off's start.
  const withGlue = (): ChatVoice => {
    glue = createChatVoice({
      daemon,
      sessionsOnChat: () => [],
      ledger: createVoiceLedger(join(mkdtempSync(join(tmpdir(), 'patch-vhol-')), 'v.jsonl')),
      logger: silent,
      onCosted: () => undefined,
      now: () => 1_700_000_000_000,
    });
    return glue;
  };
  return { daemon, events, folder, bridge, withGlue };
}

describe('a voice hand-off behind a running turn', () => {
  it('is written where it was made, once, with no pending chip', async () => {
    const g = gatedBackend();
    const { daemon, events, folder, bridge } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'busy work', localId: 'L1' });
    await tick();

    const prefix = '[voice hand-off • web] ';
    const seq = daemon.recordVoiceMessage({
      chatId,
      role: 'user',
      content: `${prefix}check the build`,
      owed: false,
    });
    const reply = bridge.awaitReply(chatId, undefined, 'H1');
    void daemon.sendInput({
      chatId,
      message: 'check the build',
      localId: 'H1',
      voicePrefix: prefix,
      fromUser: true,
      deliverDrawn: seq,
    });
    // The voice keeps talking while the agent is busy: this lands after the hand-off line.
    const later = daemon.recordVoiceMessage({
      chatId,
      role: 'assistant',
      content: '[voice • web] Still on it.',
    });
    await tick();

    expect(
      events.some((e) => e.type === 'chat.queued' && (e as { localId: string }).localId === 'H1'),
    ).toBe(false);

    g.releaseNext();
    await tick();
    g.releaseNext();
    await expect(reply).resolves.toMatchObject({ text: expect.stringContaining('reply:') });

    const handoffLines = events.filter(
      (e) =>
        e.type === 'chat.message' &&
        (e as { content: string }).content.includes('check the build') &&
        (e as { role: string }).role === 'user',
    ) as Array<{ seq: number }>;
    expect(handoffLines).toHaveLength(1);
    expect(handoffLines[0]!.seq).toBe(seq);
    expect(seq).toBeLessThan(later);
    expect(g.prompts[1]).toContain('check the build');
    expect(
      events.some((e) => e.type === 'chat.dequeued' && (e as { localId: string }).localId === 'H1'),
    ).toBe(false);
  });
});

/**
 * A turn mid-step: it stops inside a tool batch until released, then asks for
 * what arrived meanwhile at the tool boundary (as the SDK's PostToolBatch hook
 * does), says what it was given, and ends.
 */
function midStepBackend() {
  const gates: Array<() => void> = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
      yield { type: 'assistant', content: 'Running the build.', sessionId: 'sess' };
      await new Promise<void>((resolve) => gates.push(resolve));
      const given = await opts.onToolBoundary?.();
      yield { type: 'result', sessionId: 'sess' };
      yield {
        type: 'assistant',
        content: given ? `Answered: ${given.slice(-15)}` : 'Done.',
        sessionId: 'sess',
      };
    },
  };
  return { backend, release: () => gates.shift()?.() };
}

describe('a voice hand-off made while the agent is mid-step', () => {
  it('sits where it was made, and its answer is recorded on it rather than as a reply of its own', async () => {
    const m = midStepBackend();
    const { daemon, events, folder, withGlue } = setup(m.backend);
    const glue = withGlue();
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'build it', localId: 'L1' });
    await tick();

    // The voice agent passes a request on while the agent is inside its step.
    glue.link.passToAgent({
      sessionId: 's',
      chatId,
      request: 'is the build green',
      source: { kind: 'voice-app', surfaceKind: 'web', sessionId: 's' },
    });
    const rowSeq = (
      events.find(
        (e) =>
          e.type === 'chat.message' &&
          (e as { content: string }).content.endsWith('is the build green'),
      ) as { seq: number }
    ).seq;
    // The call carries on while the agent is still inside its step.
    const said = daemon.recordVoiceMessage({
      chatId,
      role: 'user',
      content: '[voice • web] and the tests?',
    });
    await tick();

    m.release(); // the step ends; the hand-off is handed over at the boundary
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === 'chat.voice_handoff' && e.state === 'answered')).toBe(
        true,
      ),
    );

    const userLines = events.filter(
      (e) => e.type === 'chat.message' && (e as { role: string }).role === 'user',
    ) as Array<{ seq: number; content: string }>;
    expect(userLines.filter((e) => e.content.includes('is the build green'))).toEqual([
      expect.objectContaining({ seq: rowSeq }),
    ]);
    expect(rowSeq).toBeLessThan(said);

    const states = events.filter((e) => e.type === 'chat.voice_handoff') as Array<{
      state: string;
      rowSeq: number;
      answerSeqs?: number[];
      answer?: string;
    }>;
    expect(states.map((h) => h.state)).toEqual(['waiting', 'working', 'answered']);
    expect(states.every((h) => h.rowSeq === rowSeq)).toBe(true);
    const answer = events.find(
      (e) =>
        e.type === 'chat.message' && (e as { content: string }).content.startsWith('Answered:'),
    ) as { seq: number; content: string };
    expect(states[2]!.answerSeqs).toEqual([answer.seq]);
    expect(states[2]!.answer).toBe(answer.content);
    // The progress line from before the hand-off was taken is not part of its answer.
    const progress = events.find(
      (e) =>
        e.type === 'chat.message' && (e as { content: string }).content === 'Running the build.',
    ) as { seq: number };
    expect(states[2]!.answerSeqs).not.toContain(progress.seq);
  });
});

describe('reply bridge turnStarted', () => {
  it('arms only the waiter that asked for that localId', async () => {
    const bridge = createVoiceReplyBridge();
    const reply = bridge.awaitReply('c', undefined, 'mine');
    let settled = false;
    void reply.then(() => (settled = true));
    const turn = (content: string): void => {
      bridge.observe({
        type: 'chat.message',
        chatId: 'c',
        role: 'assistant',
        content,
        seq: 1,
      } as unknown as WireEvent);
      bridge.observe({
        type: 'chat.turn_ended',
        chatId: 'c',
        turnId: 't',
        seq: -1,
        at: 2,
        outcome: 'completed',
      } as unknown as WireEvent);
    };
    bridge.turnStarted('c', 'other');
    turn('not mine');
    await Promise.resolve();
    expect(settled).toBe(false);
    bridge.turnStarted('c', 'mine');
    turn('done');
    await expect(reply).resolves.toMatchObject({ text: 'done' });
  });
});
