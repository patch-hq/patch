// Native voice tier unit tests (group: native voice tier). Mocks the Gemini
// Live WebSocket entirely — no real network call in this suite (this repo
// explicitly avoids spending in automated runs). See scripts/gemini-live-smoke.mjs
// for the one real, manually-run end-to-end check against the live API.

import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import type { WebSocket as WsSocket } from 'ws';
import { DEFAULT_VOICE_INSTRUCTIONS } from '@patch/wire';
import {
  GeminiLiveSession,
  DEFAULT_GEMINI_LIVE_MODEL,
  type GeminiLiveDeps,
} from '../src/audio/gemini-live.js';
import { MockVad } from '../src/audio/vad.js';
import type { SessionInit } from '../src/audio/session.js';
import { PASS_TO_AGENT_TOOL_NAME } from '../src/audio/voiceAgent.js';
import { fakeVoiceAgentLink, FAKE_START_CONTEXT } from './helpers/fakeVoiceAgentLink.js';
import { soundConfig, VOICE_AGENT_ENGINES, type AudioEvent } from '@patch/wire/audio';

const logger = pino({ level: 'silent' });

/** A fake Gemini Live socket: records every outbound frame, lets tests drive inbound ones. */
class FakeGeminiWs extends EventEmitter {
  sent: string[] = [];
  closed = false;
  constructor(public readonly url: string) {
    super();
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** Test helper: parse every sent frame as JSON. */
  sentJson(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  /** Test helper: simulate the server delivering a message. */
  serverSend(msg: unknown): void {
    this.emit('message', JSON.stringify(msg), false);
  }
}

function makeInit(overrides: Partial<SessionInit> = {}): SessionInit {
  return {
    sessionId: 'sess-1',
    accountId: 'acct-1',
    surfaceId: 'surf-1',
    surfaceKind: 'web',
    chatId: 'chat-1',
    role: 'voice-call',
    surfaceHasAec: true,
    ...overrides,
  };
}

/** Records what a session writes into the chat timeline, in order. */
export class FakeTimeline {
  log: string[] = [];
  userSaid(chatId: string, text: string): void {
    this.log.push(`user:${chatId}:${text}`);
  }
  beginReply(chatId: string): {
    append(d: string): void;
    finish(heard?: string): void;
    text(): string;
  } {
    let text = '';
    this.log.push(`begin:${chatId}`);
    return {
      append: (d: string) => {
        text += d;
        this.log.push(`delta:${d}`);
      },
      finish: (heard?: string) => {
        this.log.push(`reply:${chatId}:${heard ?? text}`);
      },
      text: () => text,
    };
  }
}

/** The text of every message the host sent Gemini as a user turn, in order. */
function clientTurns(ws: FakeGeminiWs): string[] {
  return (
    ws.sentJson() as Array<{ clientContent?: { turns: Array<{ parts: Array<{ text: string }> }> } }>
  ).flatMap((f) => (f.clientContent ? [f.clientContent.turns[0]?.parts[0]?.text ?? ''] : []));
}

function makeDeps(overrides: Partial<GeminiLiveDeps> = {}): {
  deps: GeminiLiveDeps;
  audioEvents: AudioEvent[];
  binaryFrames: Int16Array[];
  lastWs: { current?: FakeGeminiWs };
  passed: ReturnType<typeof fakeVoiceAgentLink>['passed'];
  link: ReturnType<typeof fakeVoiceAgentLink>['link'];
  timeline: FakeTimeline;
} {
  const audioEvents: AudioEvent[] = [];
  const binaryFrames: Int16Array[] = [];
  const lastWs: { current?: FakeGeminiWs } = {};
  const { link, passed } = fakeVoiceAgentLink();
  const timeline = new FakeTimeline();
  const wsCtor = function (this: FakeGeminiWs, url: string): FakeGeminiWs {
    const inst = new FakeGeminiWs(url);
    lastWs.current = inst;
    return inst;
  } as unknown as new (url: string) => WsSocket;
  const deps: GeminiLiveDeps = {
    logger,
    sendAudio: (ev) => audioEvents.push(ev),
    sendBinary: (pcm) => binaryFrames.push(pcm),
    link,
    instructions: DEFAULT_VOICE_INSTRUCTIONS,
    apiKey: 'test-key',
    wsCtor,
    timeline,
    ...overrides,
  };
  return { deps, audioEvents, binaryFrames, lastWs, passed, link, timeline };
}

/** Drive a session through connect + setupComplete, returning the fake ws. */
async function openSession(
  session: GeminiLiveSession,
  lastWs: { current?: FakeGeminiWs },
): Promise<FakeGeminiWs> {
  session.onSessionStart();
  await vi.waitFor(() => expect(lastWs.current).toBeDefined());
  const ws = lastWs.current!;
  ws.emit('open');
  await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
  ws.serverSend({ setupComplete: {} });
  await vi.waitFor(() => expect(session.getState()).toBe('listening'));
  return ws;
}

describe('GeminiLiveSession — connect + setup', () => {
  test("a call answering an agent's ring opens with its reason once setup is done", async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(
      makeInit({ callReason: 'The deploy failed; shall I roll back?' }),
      deps,
    );
    const ws = await openSession(session, lastWs);
    const turns = clientTurns(ws);
    expect(turns.at(-1)).toContain('The deploy failed; shall I roll back?');
    expect(turns.at(-1)).toContain('just answered');
    await session.close();
  });

  test('a call the user placed opens with nothing: the model waits for them', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    expect(clientTurns(ws).some((t) => t.includes('just answered'))).toBe(false);
    await session.close();
  });

  test('waits out filler pauses: long end-of-speech silence and a no-reply-to-fragments rule', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const [first] = ws.sentJson() as [
      {
        setup: {
          realtimeInputConfig: {
            automaticActivityDetection: {
              endOfSpeechSensitivity: string;
              silenceDurationMs: number;
            };
          };
          systemInstruction: { parts: Array<{ text: string }> };
        };
      },
    ];
    const aad = first.setup.realtimeInputConfig.automaticActivityDetection;
    expect(aad.endOfSpeechSensitivity).toBe('END_SENSITIVITY_LOW');
    expect(aad.silenceDurationMs).toBeGreaterThanOrEqual(1500);
    expect(first.setup.systemInstruction.parts[0]!.text).toMatch(/unfinished|fragment/i);
  });

  test('sends a setup message naming the dispatch tool and the default model', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const [first] = ws.sentJson() as [{ setup: { model: string; tools: unknown[] } }];
    expect(first.setup.model).toBe(DEFAULT_GEMINI_LIVE_MODEL);
    const tools = first.setup.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
    expect(tools[0]?.functionDeclarations[0]?.name).toBe(PASS_TO_AGENT_TOOL_NAME);
  });

  test('honours a model override', async () => {
    const { deps, lastWs } = makeDeps({ model: 'models/gemini-custom' });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const [first] = ws.sentJson() as [{ setup: { model: string } }];
    expect(first.setup.model).toBe('models/gemini-custom');
  });

  test('speaks in the chosen voice, and in Gemini’s default when none is chosen', async () => {
    const chosen = makeDeps({ voice: 'Kore' });
    const ws = await openSession(new GeminiLiveSession(makeInit(), chosen.deps), chosen.lastWs);
    const [first] = ws.sentJson() as [{ setup: { generationConfig: Record<string, unknown> } }];
    expect(first.setup.generationConfig.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
    });
    const plain = makeDeps();
    const ws2 = await openSession(new GeminiLiveSession(makeInit(), plain.deps), plain.lastWs);
    const [setup2] = ws2.sentJson() as [{ setup: { generationConfig: Record<string, unknown> } }];
    expect(setup2.setup.generationConfig.speechConfig).toBeUndefined();
  });

  test('match my tone: affective dialog in the setup, on the v1alpha API; the tone in the instructions', async () => {
    const { deps, lastWs } = makeDeps({
      tone: 'Calm and sincere.',
      soundConfig: soundConfig(
        VOICE_AGENT_ENGINES.gemini,
        { matchTone: true },
        'Calm and sincere.',
      ),
    });
    const ws = await openSession(new GeminiLiveSession(makeInit(), deps), lastWs);
    expect(ws.url).toContain('.v1alpha.GenerativeService');
    const [setup] = ws.sentJson() as [
      {
        setup: {
          generationConfig: Record<string, unknown>;
          systemInstruction: { parts: [{ text: string }] };
        };
      },
    ];
    expect(setup.setup.generationConfig['enableAffectiveDialog']).toBe(true);
    expect(setup.setup.systemInstruction.parts[0].text).toContain('Calm and sincere.');
  });

  test('match my tone off: v1beta, and the field is not sent', async () => {
    const { deps, lastWs } = makeDeps({
      soundConfig: soundConfig(VOICE_AGENT_ENGINES.gemini, {}, undefined),
    });
    const ws = await openSession(new GeminiLiveSession(makeInit(), deps), lastWs);
    expect(ws.url).toContain('.v1beta.GenerativeService');
    const [setup] = ws.sentJson() as [{ setup: { generationConfig: Record<string, unknown> } }];
    expect('enableAffectiveDialog' in setup.setup.generationConfig).toBe(false);
  });

  test('the instructions are the voice instructions, then the chat as it stands — nothing else', async () => {
    const { deps, lastWs, link } = makeDeps({ instructions: 'Be the voice of this chat.' });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    expect(link.startContext).toHaveBeenCalledWith('chat-1');
    const [first] = ws.sentJson() as [
      { setup: { systemInstruction: { parts: Array<{ text: string }> } } },
    ];
    expect(first.setup.systemInstruction.parts[0]!.text).toBe(
      `Be the voice of this chat.\n\n${FAKE_START_CONTEXT}`,
    );
    // The history is not replayed as turns as well.
    expect(ws.sentJson().some((f) => 'clientContent' in (f as object))).toBe(false);
  });

  test('the tone goes after the instructions and before the start context', async () => {
    const { deps, lastWs } = makeDeps({ instructions: 'Voice.', tone: 'Calm and slow.' });
    const ws = await openSession(new GeminiLiveSession(makeInit(), deps), lastWs);
    const [first] = ws.sentJson() as [
      { setup: { systemInstruction: { parts: Array<{ text: string }> } } },
    ];
    expect(first.setup.systemInstruction.parts[0]!.text).toBe(
      `Voice.\n\nCalm and slow.\n\n${FAKE_START_CONTEXT}`,
    );
  });

  test('a chat that cannot be read fails the session loudly', async () => {
    const { link } = fakeVoiceAgentLink({
      startContext: () => {
        throw new Error('chat chat-1 not found');
      },
    });
    const { deps, lastWs, audioEvents } = makeDeps({ link });
    const session = new GeminiLiveSession(makeInit(), deps);
    session.onSessionStart();
    await vi.waitFor(() => expect(lastWs.current).toBeDefined());
    lastWs.current!.emit('open');
    await vi.waitFor(() =>
      expect(audioEvents.some((e) => e.type === 'audio.error' && /not found/.test(e.message))).toBe(
        true,
      ),
    );
    expect(session.getState()).not.toBe('listening');
  });

  test('a catch-up written while the call connects is added to the conversation without a reply', async () => {
    let write!: (text: string) => void;
    const catchUp = new Promise<string>((r) => (write = r));
    const { link } = fakeVoiceAgentLink({
      startContext: () => ({ text: FAKE_START_CONTEXT, catchUp }),
    });
    const { deps, lastWs } = makeDeps({ link });
    const ws = await openSession(new GeminiLiveSession(makeInit(), deps), lastWs);
    write('They are planning a trip to Leeds.');
    await vi.waitFor(() => expect(clientTurns(ws)).toHaveLength(1));
    expect(clientTurns(ws)[0]).toContain('They are planning a trip to Leeds.');
    const frame = (ws.sentJson() as Array<{ clientContent?: { turnComplete: boolean } }>).find(
      (f) => f.clientContent,
    );
    expect(frame?.clientContent?.turnComplete).toBe(false);
  });

  test('a catch-up that fails is shown on the call bar and the call carries on', async () => {
    const { link } = fakeVoiceAgentLink({
      startContext: () => ({
        text: FAKE_START_CONTEXT,
        catchUp: Promise.reject(new Error('every small-job model failed')),
      }),
    });
    const { deps, lastWs, audioEvents } = makeDeps({ link });
    const session = new GeminiLiveSession(makeInit(), deps);
    await openSession(session, lastWs);
    await vi.waitFor(() =>
      expect(
        audioEvents.some(
          (e) =>
            e.type === 'audio.error' && e.code === 'catch_up_failed' && /small-job/.test(e.message),
        ),
      ).toBe(true),
    );
    expect(session.getState()).toBe('listening');
  });

  test('emits gemini_unavailable and never sets state=listening when the socket errors before open', async () => {
    const { deps, audioEvents, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    session.onSessionStart();
    await vi.waitFor(() => expect(lastWs.current).toBeDefined());
    lastWs.current!.emit('error', new Error('ECONNREFUSED'));
    await vi.waitFor(() =>
      expect(
        audioEvents.some((e) => e.type === 'audio.error' && e.code === 'gemini_unavailable'),
      ).toBe(true),
    );
    expect(session.getState()).not.toBe('listening');
  });
});

describe('GeminiLiveSession — mic audio', () => {
  test('queues mic frames until setup completes, then flushes them as realtimeInput', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    session.onSessionStart();
    await vi.waitFor(() => expect(lastWs.current).toBeDefined());
    const ws = lastWs.current!;
    // Mic frame BEFORE open/setupComplete: must not be sent yet.
    const pcm = new Int16Array([1, 2, 3, 4]);
    await session.onMicFrame(pcm);
    expect(ws.sent.some((s) => s.includes('realtimeInput'))).toBe(false);
    ws.emit('open');
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    ws.serverSend({ setupComplete: {} });
    await vi.waitFor(() => expect(ws.sent.some((s) => s.includes('realtimeInput'))).toBe(true));
    const frame = (
      ws.sentJson() as Array<{ realtimeInput?: { audio: { data: string; mimeType: string } } }>
    ).find((f) => f.realtimeInput);
    expect(frame?.realtimeInput?.audio.mimeType).toBe('audio/pcm;rate=16000');
    const decoded = Buffer.from(frame!.realtimeInput!.audio.data, 'base64');
    expect(decoded.readInt16LE(0)).toBe(1);
    expect(decoded.readInt16LE(6)).toBe(4);
  });

  test('sends a mic frame immediately once setup is done', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const before = ws.sent.length;
    await session.onMicFrame(new Int16Array([42]));
    expect(ws.sent.length).toBe(before + 1);
  });

  test('stats() reports mic frame/sample counts', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    await openSession(session, lastWs);
    // Rounded to 1 decimal place (mirrors VoiceSession.stats()) — use enough
    // samples that the rounding lands on a non-zero, easily-asserted value.
    await session.onMicFrame(new Int16Array(8000));
    await session.onMicFrame(new Int16Array(8000));
    const stats = session.stats();
    expect(stats.micFrames).toBe(2);
    expect(stats.micSeconds).toBeCloseTo(1.0, 5);
    expect(stats.vadEvents).toBe(0);
  });
});

describe('GeminiLiveSession — audio out + turn lifecycle', () => {
  test('forwards inlineData audio as tts_chunk/sendBinary and transitions to speaking', async () => {
    const { deps, lastWs, audioEvents, binaryFrames } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const pcm = new Int16Array([10, 20, 30]);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    ws.serverSend({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: b64 } }] },
      },
    });
    await vi.waitFor(() => expect(binaryFrames.length).toBe(1));
    expect(Array.from(binaryFrames[0]!)).toEqual([10, 20, 30]);
    expect(audioEvents.some((e) => e.type === 'audio.tts_chunk' && e.samples === 3)).toBe(true);
    expect(session.getState()).toBe('speaking');
  });

  test('turnComplete with accumulated input transcription emits transcript_final + tts_end and returns to listening', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: 'what time ' } } });
    ws.serverSend({ serverContent: { inputTranscription: { text: 'is it' } } });
    const pcm = new Int16Array([1]);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    ws.serverSend({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64 } }] } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(audioEvents.some((e) => e.type === 'audio.transcript_final')).toBe(true),
    );
    const final = audioEvents.find((e) => e.type === 'audio.transcript_final');
    expect(final && 'text' in final ? final.text : undefined).toBe('what time is it');
    expect(audioEvents.some((e) => e.type === 'audio.tts_end')).toBe(true);
    expect(session.getState()).toBe('listening');
    expect(session.stats().turns).toBe(1);
  });

  test('a <noise> turn is no input: nothing written to the chat and the model reply is dropped', async () => {
    const { deps, lastWs, audioEvents, binaryFrames, timeline } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: '<noise>' } } });
    const pcm = new Int16Array([1]);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    ws.serverSend({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: b64 } }] },
        outputTranscription: { text: "I've added unbleached kitchen roll to your list." },
      },
    });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(audioEvents.some((e) => e.type === 'audio.tts_end')).toBe(true));
    expect(session.stats().turns).toBe(0);
    expect(audioEvents.some((e) => e.type === 'audio.transcript_final')).toBe(false);
    expect(
      audioEvents.some((e) => e.type === 'audio.transcript_partial' && e.text.includes('noise')),
    ).toBe(false);
    expect(binaryFrames.length).toBe(0);
    expect(timeline.log).toEqual([]);
  });

  test('a lone "." transcript is no input: no partial, no chat message', async () => {
    const { deps, lastWs, audioEvents, timeline } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: '.' } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await new Promise((r) => setTimeout(r, 20));
    expect(session.stats().turns).toBe(0);
    expect(audioEvents.some((e) => e.type === 'audio.transcript_partial')).toBe(false);
    expect(audioEvents.some((e) => e.type === 'audio.transcript_final')).toBe(false);
    expect(timeline.log).toEqual([]);
  });

  test('a turn with input but no TTS audio reports gemini_unavailable (NO SILENT FAILURES)', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: 'hello' } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(
        audioEvents.some((e) => e.type === 'audio.error' && e.code === 'gemini_unavailable'),
      ).toBe(true),
    );
  });

  test('a turn the model answers with bare "..." and no audio is not a call failure', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: 'ఆహ్ మనం' } } });
    ws.serverSend({ serverContent: { outputTranscription: { text: '...' } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(audioEvents.some((e) => e.type === 'audio.tts_end')).toBe(true));
    expect(audioEvents.some((e) => e.type === 'audio.error')).toBe(false);
  });

  test('a light-layer-only turn with no dispatch still produces exactly one transcript_final + tts_end', async () => {
    const { deps, lastWs, audioEvents, passed } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({
      serverContent: { inputTranscription: { text: "what's the capital of France" } },
    });
    const pcm = new Int16Array([7]);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    ws.serverSend({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64 } }] } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(audioEvents.filter((e) => e.type === 'audio.transcript_final').length).toBe(1),
    );
    expect(audioEvents.filter((e) => e.type === 'audio.tts_end').length).toBe(1);
    // The voice answered this itself — nothing passed to the chat's agent.
    expect(passed).toHaveLength(0);
  });

  test('barge-in (interrupted) emits audio.barge_in + tts_end{bargedIn:true} and returns to listening', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const pcm = new Int16Array([1]);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    ws.serverSend({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64 } }] } } });
    await vi.waitFor(() => expect(session.getState()).toBe('speaking'));
    ws.serverSend({ serverContent: { interrupted: true } });
    await vi.waitFor(() => expect(session.getState()).toBe('listening'));
    expect(audioEvents.some((e) => e.type === 'audio.barge_in')).toBe(true);
    const end = audioEvents.find((e) => e.type === 'audio.tts_end');
    expect(end && 'bargedIn' in end ? end.bargedIn : undefined).toBe(true);
  });

  test('the turnComplete that follows a barge-in is not reported as a reply with no TTS audio', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const pcm = new Int16Array([1]);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    ws.serverSend({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64 } }] } } });
    await vi.waitFor(() => expect(session.getState()).toBe('speaking'));
    ws.serverSend({ serverContent: { inputTranscription: { text: 'wait' } } });
    ws.serverSend({ serverContent: { interrupted: true } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(session.stats().turns).toBe(1));
    expect(audioEvents.some((e) => e.type === 'audio.error')).toBe(false);
  });
});

describe('GeminiLiveSession — pass to agent', () => {
  test('answers "received" at once and passes the request to the chat agent', async () => {
    const { deps, lastWs, passed } = makeDeps();
    const init = makeInit({ surfaceKind: 'mobile', sessionId: 'sess-42', chatId: 'chat-42' });
    const session = new GeminiLiveSession(init, deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 'call-1', name: PASS_TO_AGENT_TOOL_NAME, args: { request: 'add milk to my list' } },
        ],
      },
    });
    await vi.waitFor(() => expect(ws.sent.some((s) => s.includes('toolResponse'))).toBe(true));
    expect(passed).toEqual([
      { sessionId: 'sess-42', chatId: 'chat-42', request: 'add milk to my list' },
    ]);
    const answered = (
      ws.sentJson() as Array<{
        toolResponse?: {
          functionResponses: Array<{
            id: string;
            name: string;
            response: { result: string; scheduling: string };
          }>;
        };
      }>
    ).find((f) => f.toolResponse);
    expect(answered?.toolResponse?.functionResponses[0]).toMatchObject({
      id: 'call-1',
      name: PASS_TO_AGENT_TOOL_NAME,
      response: { result: 'received', scheduling: 'WHEN_IDLE' },
    });
    // Nothing is said on the agent's behalf until its answer is pushed.
    expect(clientTurns(ws)).toHaveLength(0);
  });

  test('dispatches count toward stats().turns via the following turnComplete', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: "what's my next train" } } });
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 'c1', name: PASS_TO_AGENT_TOOL_NAME, args: { request: "what's my next train" } },
        ],
      },
    });
    await vi.waitFor(() => expect(ws.sent.some((s) => s.includes('toolResponse'))).toBe(true));
    const pcm = new Int16Array([1]);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    ws.serverSend({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64 } }] } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(session.stats().turns).toBe(1));
  });

  test('a request that could not be passed on is an error, and the voice is told so', async () => {
    const { link } = fakeVoiceAgentLink({
      passToAgent: () => {
        throw new Error('chat chat-1 not found');
      },
    });
    const { deps, lastWs, audioEvents } = makeDeps({ link });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 'c2', name: PASS_TO_AGENT_TOOL_NAME, args: { request: 'do a thing' } },
        ],
      },
    });
    await vi.waitFor(() => expect(ws.sent.some((s) => s.includes('Not passed on'))).toBe(true));
    expect(ws.sent.some((s) => s.includes('"received"'))).toBe(false);
    expect(audioEvents.some((e) => e.type === 'audio.error' && /not found/.test(e.message))).toBe(
      true,
    );
  });

  test('check_status, look_back and switch_chat are answered from the host at once', async () => {
    const { deps, lastWs, link } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 's1', name: 'check_status', args: {} },
          { id: 's2', name: 'look_back', args: { query: 'dentist' } },
          { id: 's3', name: 'switch_chat', args: { chat: 'x' } },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(ws.sent.filter((s) => s.includes('toolResponse'))).toHaveLength(3),
    );
    expect(link.checkStatus).toHaveBeenCalledWith('sess-1', 'chat-1');
    expect(link.lookBack).toHaveBeenCalledWith('chat-1', 'dentist');
    expect(link.switchChat).toHaveBeenCalledWith('sess-1', 'chat-1', 'x');
    const results = (
      ws.sentJson() as Array<{
        toolResponse?: {
          functionResponses: Array<{ response: { result: string; scheduling: string } }>;
        };
      }>
    ).flatMap((f) => f.toolResponse?.functionResponses ?? []);
    expect(results.map((r) => r.response.result)).toEqual([
      'status of chat-1',
      'found in chat-1: dentist on Tuesday',
      'No chat matches "x".',
    ]);
    expect(results.every((r) => r.response.scheduling === 'INTERRUPT')).toBe(true);
  });

  test('switch_chat moves the call: its words land in the new chat and its context is in the answer', async () => {
    const { link } = fakeVoiceAgentLink({
      switchChat: async () => ({
        ok: true,
        chatId: 'chat-2',
        name: 'Garden',
        context: { text: 'THE CHAT AS IT STANDS\nChat: Garden', catchUp: null },
      }),
    });
    const { deps, lastWs, timeline } = makeDeps({ link });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({
      toolCall: { functionCalls: [{ id: 'w1', name: 'switch_chat', args: { chat: 'garden' } }] },
    });
    await vi.waitFor(() => expect(ws.sent.some((s) => s.includes('Chat: Garden'))).toBe(true));
    expect(session.getCurrentChatId()).toBe('chat-2');
    ws.serverSend({ serverContent: { inputTranscription: { text: 'how are the roses' } } });
    ws.serverSend({ serverContent: { outputTranscription: { text: 'Fine.' } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(timeline.log).toContain('user:chat-2:how are the roses'));
  });

  test('an unknown tool is answered as unknown, and nothing is passed on', async () => {
    const { deps, lastWs, passed } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({
      toolCall: { functionCalls: [{ id: 'x', name: 'some_other_tool', args: {} }] },
    });
    await vi.waitFor(() => expect(ws.sent.some((s) => s.includes('no tool called'))).toBe(true));
    expect(passed).toHaveLength(0);
  });
});

describe('GeminiLiveSession — mode/focus passthrough + scope cuts', () => {
  test('setMode/getMode round-trip', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit({ mode: 'call' }), deps);
    await openSession(session, lastWs);
    expect(session.getMode()).toBe('call');
    session.setMode('hands-free');
    expect(session.getMode()).toBe('hands-free');
  });

  test('setFocus/getCurrentChatId round-trip', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit({ chatId: 'chat-a' }), deps);
    await openSession(session, lastWs);
    expect(session.getCurrentChatId()).toBe('chat-a');
    session.setFocus('chat-b');
    expect(session.getCurrentChatId()).toBe('chat-b');
  });

  test('finalizeNote is a documented no-op (voice notes stay on the fallback tier)', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    await openSession(session, lastWs);
    await expect(session.finalizeNote()).resolves.toBe(false);
  });

  test('injectTranscript sends a real text clientContent turn (dev/test seam, spec/07)', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    await session.injectTranscript('hello there');
    const frame = (
      ws.sentJson() as Array<{
        clientContent?: {
          turns: Array<{ role: string; parts: Array<{ text: string }> }>;
          turnComplete: boolean;
        };
      }>
    ).find((f) => f.clientContent?.turnComplete === true);
    expect(frame?.clientContent?.turns).toEqual([
      { role: 'user', parts: [{ text: 'hello there' }] },
    ]);
  });

  test('speak() asks Gemini to say the text verbatim (documented approximation)', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    await session.speak('your parcel has arrived');
    const frame = (
      ws.sentJson() as Array<{
        clientContent?: { turns: Array<{ parts: Array<{ text: string }> }> };
      }>
    ).find((f) => f.clientContent);
    expect(frame?.clientContent?.turns[0]?.parts[0]?.text).toContain('your parcel has arrived');
  });

  test('close() closes the socket and further mic frames are dropped', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    await session.close();
    expect(ws.closed).toBe(true);
    const before = ws.sent.length;
    await session.onMicFrame(new Int16Array([1]));
    expect(ws.sent.length).toBe(before);
  });

  test('the user’s words stream to the surface as partials while Gemini hears them', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: 'turn the ' } } });
    ws.serverSend({ serverContent: { inputTranscription: { text: 'lights off' } } });
    expect(
      audioEvents
        .filter((e) => e.type === 'audio.transcript_partial')
        .map((e) => (e as { text: string }).text),
    ).toEqual(['turn the', 'turn the lights off']);
    expect(session.getState()).toBe('transcribing');
  });

  test('Gemini hanging up mid-call is fatal and loud, not a log line', async () => {
    const onFatal = vi.fn();
    const { deps, lastWs, audioEvents } = makeDeps({ onFatal });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.emit('close', 1011, Buffer.from('internal'));
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(audioEvents.at(-1)).toMatchObject({
      type: 'audio.error',
      code: 'gemini_unavailable',
      message: expect.stringContaining('1011: internal'),
    });
  });

  test('Gemini closing before setupComplete (bad model/key) fails the session instead of hanging', async () => {
    const onFatal = vi.fn();
    const { deps, lastWs, audioEvents } = makeDeps({ onFatal });
    const session = new GeminiLiveSession(makeInit(), deps);
    session.onSessionStart();
    await vi.waitFor(() => expect(lastWs.current).toBeDefined());
    const ws = lastWs.current!;
    ws.emit('open');
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    ws.emit('close', 1008, 'model not found');
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
    expect(audioEvents.filter((e) => e.type === 'audio.error')).toHaveLength(1);
    expect(session.getState()).toBe('connecting');
  });

  test('our own close() is not reported as a failure', async () => {
    const onFatal = vi.fn();
    const { deps, lastWs, audioEvents } = makeDeps({ onFatal });
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    await session.close();
    ws.emit('close', 1000, '');
    expect(onFatal).not.toHaveBeenCalled();
    expect(audioEvents.some((e) => e.type === 'audio.error')).toBe(false);
  });
});

// spec/07 § Keeping voice and text as one conversation / § The fast voice and
// the chat's agent / § Call cost.
describe('GeminiLiveSession — one conversation with the chat', () => {
  const audio = (n = 4) => Buffer.alloc(n).toString('base64');

  test('writes the user words, then streams the spoken reply, into the chat timeline', async () => {
    const { deps, lastWs, timeline, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);

    ws.serverSend({ serverContent: { inputTranscription: { text: 'what is ' } } });
    ws.serverSend({ serverContent: { inputTranscription: { text: 'a nebula' } } });
    expect(timeline.log).toEqual([]);
    ws.serverSend({
      serverContent: {
        outputTranscription: { text: 'A cloud ' },
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: audio() } }] },
      },
    });
    ws.serverSend({ serverContent: { outputTranscription: { text: 'of gas.' } } });
    ws.serverSend({ serverContent: { turnComplete: true } });

    // Written once it has played out.
    await vi.waitFor(() => expect(timeline.log.at(-1)).toMatch(/^reply:/));
    expect(timeline.log).toEqual([
      'user:chat-1:what is a nebula',
      'begin:chat-1',
      'delta:A cloud ',
      'delta:of gas.',
      'reply:chat-1:A cloud of gas.',
    ]);
    // The final transcript reaches the surface as soon as the reply starts,
    // not only once the whole reply has played.
    const finalIdx = audioEvents.findIndex((e) => e.type === 'audio.transcript_final');
    const ttsIdx = audioEvents.findIndex((e) => e.type === 'audio.tts_chunk');
    expect(finalIdx).toBeGreaterThanOrEqual(0);
    expect(finalIdx).toBeLessThan(ttsIdx);
  });

  test("a hand-off flushes the words and the bridge, goes to the chat's agent, and what the voice says of the answer is written too", async () => {
    const { deps, lastWs, timeline, passed } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);

    ws.serverSend({ serverContent: { inputTranscription: { text: 'add milk to my list' } } });
    ws.serverSend({ serverContent: { outputTranscription: { text: 'Passing that on.' } } });
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 'call-1', name: PASS_TO_AGENT_TOOL_NAME, args: { request: 'Add milk' } },
        ],
      },
    });
    await vi.waitFor(() => expect(passed).toHaveLength(1));
    expect(passed[0]).toMatchObject({ chatId: 'chat-1', request: 'Add milk' });
    expect(timeline.log).toEqual([
      'user:chat-1:add milk to my list',
      'begin:chat-1',
      'delta:Passing that on.',
      'reply:chat-1:Passing that on.',
    ]);
    ws.serverSend({ serverContent: { turnComplete: true } });
    // The answer is pushed in; the model speaks the gist, which is written too.
    session.pushMessage("Answer from the chat's agent: milk added", { handoffSettled: true });
    await vi.waitFor(() => expect(clientTurns(ws)).toHaveLength(1));
    ws.serverSend({ serverContent: { outputTranscription: { text: 'Milk is on the list.' } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    expect(timeline.log.filter((l) => l.startsWith('reply:'))).toEqual([
      'reply:chat-1:Passing that on.',
      'reply:chat-1:Milk is on the list.',
    ]);
  });

  test('the instructions carry no rules of the host’s own: tools say what they do', async () => {
    const { deps, lastWs } = makeDeps({ instructions: 'Only this.' });
    const ws = await openSession(new GeminiLiveSession(makeInit(), deps), lastWs);
    const [first] = ws.sentJson() as [
      {
        setup: {
          systemInstruction: { parts: [{ text: string }] };
          tools: Array<{ functionDeclarations: Array<{ name: string; description: string }> }>;
        };
      },
    ];
    expect(first.setup.systemInstruction.parts[0].text.startsWith('Only this.\n\n')).toBe(true);
    expect(first.setup.systemInstruction.parts[0].text).not.toMatch(/acknowledgement|one sec/i);
    const decls = first.setup.tools[0]!.functionDeclarations;
    expect(decls.map((d) => d.name)).toEqual([
      PASS_TO_AGENT_TOOL_NAME,
      'check_status',
      'look_back',
      'end_call',
      'switch_chat',
    ]);
    expect(decls[0]!.description).toMatch(/received/);
  });

  test('a barge-in writes only what was heard of the reply into the chat', async () => {
    const { deps, lastWs, timeline } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: 'tell me a story' } } });
    // 2s of audio and its words arrive at once; the user cuts in after a fraction of it.
    const pcm = new Int16Array(48_000);
    const data = Buffer.from(pcm.buffer).toString('base64');
    ws.serverSend({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data } }] },
        outputTranscription: { text: 'Once upon a time there was a very long story indeed.' },
      },
    });
    await new Promise((r) => setTimeout(r, 600));
    ws.serverSend({ serverContent: { interrupted: true } });
    const reply = timeline.log.find((l) => l.startsWith('reply:'))!;
    expect(reply).toMatch(/^reply:chat-1:Once upon/);
    expect(reply.length).toBeLessThan(
      'reply:chat-1:Once upon a time there was a very long story indeed.'.length,
    );
  });

  test('tallies the usage Gemini reports, the last report of each turn, by modality', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    const usage = (audioIn: number, textIn: number, audioOut: number) => ({
      promptTokenCount: audioIn + textIn,
      responseTokenCount: audioOut,
      promptTokensDetails: [
        { modality: 'AUDIO', tokenCount: audioIn },
        { modality: 'TEXT', tokenCount: textIn },
      ],
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: audioOut }],
    });
    ws.serverSend({
      serverContent: { inputTranscription: { text: 'hi' } },
      usageMetadata: usage(10, 5, 1),
    });
    ws.serverSend({ serverContent: { turnComplete: true }, usageMetadata: usage(100, 50, 40) });
    ws.serverSend({ serverContent: { inputTranscription: { text: 'again' } } });
    ws.serverSend({ serverContent: { turnComplete: true }, usageMetadata: usage(200, 60, 30) });

    expect(session.engineCosting()).toEqual({
      backend: 'gemini',
      model: DEFAULT_GEMINI_LIVE_MODEL,
      tokens: { textIn: 110, audioIn: 300, cachedIn: 0, textOut: 0, audioOut: 70 },
      stt: null,
    });
  });
});

function speech(): unknown {
  const pcm = new Int16Array([1, 2]);
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
  return { serverContent: { modelTurn: { parts: [{ inlineData: { data } }] } } };
}

const dispatchCall = {
  toolCall: {
    functionCalls: [
      { id: 'call-1', name: PASS_TO_AGENT_TOOL_NAME, args: { request: 'list files' } },
    ],
  },
};

describe('GeminiLiveSession — waiting on a hand-off', () => {
  const answer = (session: GeminiLiveSession, text: string): void =>
    session.pushMessage(`Answer from the chat's agent: ${text}`, { handoffSettled: true });

  test('one acknowledgement is spoken; the model talking on its own after that is dropped', async () => {
    const { deps, lastWs, binaryFrames } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: 'list the files' } } });
    ws.serverSend(dispatchCall);
    ws.serverSend(speech()); // "one sec"
    ws.serverSend({ serverContent: { turnComplete: true } });
    ws.serverSend(speech()); // "I've passed that on" — the one acknowledgement
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(binaryFrames.length).toBe(2));

    ws.serverSend(speech()); // "still working on it"
    ws.serverSend({ serverContent: { turnComplete: true } });
    ws.serverSend(speech()); // "waiting"
    ws.serverSend({ serverContent: { turnComplete: true } });
    expect(binaryFrames.length).toBe(2);
    // The voice carries on: the line is open for the user.
    expect(session.getState()).toBe('listening');
  });

  test('what the user says while waiting still gets a spoken reply', async () => {
    const { deps, lastWs, binaryFrames } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend(dispatchCall);
    ws.serverSend(speech());
    ws.serverSend({ serverContent: { turnComplete: true } });
    ws.serverSend(speech());
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(binaryFrames.length).toBe(2));

    ws.serverSend({ serverContent: { inputTranscription: { text: "what's the weather" } } });
    ws.serverSend(speech());
    ws.serverSend({ serverContent: { turnComplete: true } });
    expect(binaryFrames.length).toBe(3);
  });

  test('the agent answer is said as a message once the conversation is quiet', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend(dispatchCall);
    ws.serverSend({ serverContent: { turnComplete: true } });
    answer(session, 'index.html');
    await vi.waitFor(() => expect(clientTurns(ws)).toHaveLength(1));
    expect(clientTurns(ws)[0]).toContain('index.html');
    // The model speaks it; that is the agent's reply, already in the chat.
    ws.serverSend(speech());
    ws.serverSend({ serverContent: { turnComplete: true } });
    expect(audioEvents.some((e) => e.type === 'audio.error')).toBe(false);
  });

  test('the answer waits while the user is talking, and is said when they stop', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend(dispatchCall);
    ws.serverSend({ serverContent: { turnComplete: true } });
    ws.serverSend({ serverContent: { inputTranscription: { text: 'and another thing' } } });
    answer(session, 'index.html');
    await new Promise((r) => setTimeout(r, 30));
    expect(clientTurns(ws)).toHaveLength(0);
    ws.serverSend(speech());
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(clientTurns(ws)).toHaveLength(1));
  });

  test('pushes are said one at a time, in the order they arrived', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    session.pushMessage('first');
    session.pushMessage('second');
    await vi.waitFor(() => expect(clientTurns(ws)).toEqual(['first']));
    ws.serverSend(speech());
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(clientTurns(ws)).toEqual(['first', 'second']));
  });

  test('a server cancellation does not lose the answer', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend(dispatchCall);
    ws.serverSend({ serverContent: { turnComplete: true } });
    ws.serverSend({ toolCallCancellation: { ids: ['call-1'] } });
    answer(session, 'index.html');
    await vi.waitFor(() => expect(clientTurns(ws)).toHaveLength(1));
    expect(clientTurns(ws)[0]).toContain('index.html');
  });

  test('an answer the model never speaks is reported, not swallowed', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend(dispatchCall);
    ws.serverSend({ serverContent: { turnComplete: true } });
    answer(session, 'index.html');
    await vi.waitFor(() => expect(clientTurns(ws)).toHaveLength(1));
    ws.serverSend({ serverContent: { turnComplete: true } }); // the turn ends with no speech
    expect(audioEvents.some((e) => e.type === 'audio.error')).toBe(true);
  });
});

describe('GeminiLiveSession — hand-off mode', () => {
  async function toolsFor(handoff: 'auto' | 'always' | 'never'): Promise<string[]> {
    const { deps, lastWs } = makeDeps({ handoff });
    const ws = await openSession(new GeminiLiveSession(makeInit(), deps), lastWs);
    const first = ws.sentJson()[0] as {
      setup: { tools?: Array<{ functionDeclarations: Array<{ name: string }> }> };
    };
    return (first.setup.tools?.[0]?.functionDeclarations ?? []).map((d) => d.name);
  }

  test('auto and always: the voice can pass work on and ask how it stands', async () => {
    for (const mode of ['auto', 'always'] as const) {
      expect(await toolsFor(mode)).toEqual([
        PASS_TO_AGENT_TOOL_NAME,
        'check_status',
        'look_back',
        'end_call',
        'switch_chat',
      ]);
    }
  });

  test('never: no agent behind the voice, so nothing to pass on', async () => {
    expect(await toolsFor('never')).toEqual(['look_back', 'end_call', 'switch_chat']);
  });
});

describe('GeminiLiveSession — false hand-off claims', () => {
  const say = (ws: FakeGeminiWs, user: string | null, model: string): void => {
    if (user) ws.serverSend({ serverContent: { inputTranscription: { text: user } } });
    ws.serverSend({ serverContent: { outputTranscription: { text: model } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
  };
  const corrections = (ws: FakeGeminiWs): string[] =>
    clientTurns(ws).filter((t) => /did not call pass_to_agent/.test(t));

  test('claims "passed that on" without calling the tool: the model is told to send it now', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    say(ws, 'look in on my other chats', "I've passed that on.");
    await vi.waitFor(() => expect(corrections(ws)).toHaveLength(1));
  });

  test('claiming again after the correction is an audible error, not a loop', async () => {
    const { deps, lastWs, audioEvents } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    say(ws, 'look in on my other chats', "I've passed that on.");
    await vi.waitFor(() => expect(corrections(ws)).toHaveLength(1));
    say(ws, null, 'The agent is still working on it. The results will arrive shortly.');
    await vi.waitFor(() =>
      expect(audioEvents.some((e) => e.type === 'audio.error' && /not sent/i.test(e.message))).toBe(
        true,
      ),
    );
    expect(corrections(ws)).toHaveLength(1);
  });

  test('a turn that really dispatched is left alone', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    ws.serverSend({ serverContent: { inputTranscription: { text: 'add milk' } } });
    ws.serverSend({
      toolCall: {
        functionCalls: [{ id: 'c1', name: PASS_TO_AGENT_TOOL_NAME, args: { request: 'milk' } }],
      },
    });
    say(ws, null, "I've passed that on.");
    await new Promise((r) => setTimeout(r, 20));
    expect(corrections(ws)).toHaveLength(0);
  });

  test('a dispatch call that lands just after the claiming turn completes is not called unsent', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    say(ws, 'check my train times today', "I've passed that on.");
    ws.serverSend({
      toolCall: {
        functionCalls: [{ id: 'c1', name: PASS_TO_AGENT_TOOL_NAME, args: { request: 'trains' } }],
      },
    });
    await new Promise((r) => setTimeout(r, 700));
    expect(corrections(ws)).toHaveLength(0);
  });

  test('ordinary speech is left alone', async () => {
    const { deps, lastWs } = makeDeps();
    const session = new GeminiLiveSession(makeInit(), deps);
    const ws = await openSession(session, lastWs);
    say(ws, 'what is two plus two', 'Four.');
    await new Promise((r) => setTimeout(r, 20));
    expect(corrections(ws)).toHaveLength(0);
  });
});

describe('GeminiLiveSession — hands-free address gate', () => {
  const gate = (text: string): NonNullable<GeminiLiveDeps['gate']> => ({
    makeVad: () => new MockVad(),
    transcriber: {
      supportsLivePartials: false,
      transcribe: async () => text,
      transcribeClip: async () => text,
      close: async () => {},
    },
  });
  const speak = async (session: GeminiLiveSession): Promise<void> => {
    for (let i = 0; i < 15; i++) await session.onMicFrame(new Int16Array(512).fill(8000));
    for (let i = 0; i < 80; i++) await session.onMicFrame(new Int16Array(512));
  };
  const realtime = (ws: FakeGeminiWs): Array<Record<string, unknown>> =>
    (ws.sentJson() as Array<{ realtimeInput?: Record<string, unknown> }>)
      .filter((f) => f.realtimeInput)
      .map((f) => f.realtimeInput!);

  test('with a gate, Gemini activity detection is switched off', async () => {
    const { deps, lastWs } = makeDeps({ gate: gate('') });
    const ws = await openSession(
      new GeminiLiveSession(makeInit({ mode: 'hands-free' }), deps),
      lastWs,
    );
    const [first] = ws.sentJson() as [
      { setup: { realtimeInputConfig: { automaticActivityDetection: unknown } } },
    ];
    expect(first.setup.realtimeInputConfig.automaticActivityDetection).toEqual({ disabled: true });
  });

  test('hands-free: speech without the address word sends Gemini nothing and shows greyed', async () => {
    const { deps, lastWs, audioEvents } = makeDeps({ gate: gate('what is the weather') });
    const session = new GeminiLiveSession(makeInit({ mode: 'hands-free' }), deps);
    const ws = await openSession(session, lastWs);
    await speak(session);
    await vi.waitFor(() =>
      expect(audioEvents).toContainEqual(
        expect.objectContaining({ type: 'audio.transcript_final', addressed: false }),
      ),
    );
    expect(realtime(ws)).toEqual([]);
  });

  test('hands-free: speech opening with the address word is sent as one activity', async () => {
    const { deps, lastWs } = makeDeps({ gate: gate('Patch, what is the weather') });
    const session = new GeminiLiveSession(makeInit({ mode: 'hands-free' }), deps);
    const ws = await openSession(session, lastWs);
    await speak(session);
    await vi.waitFor(() => expect(realtime(ws).at(-1)).toEqual({ activityEnd: {} }));
    expect(realtime(ws)[0]).toEqual({ activityStart: {} });
  });

  test('call: speech streams to Gemini whatever it says', async () => {
    const { deps, lastWs } = makeDeps({ gate: gate('what is the weather') });
    const session = new GeminiLiveSession(makeInit({ mode: 'call' }), deps);
    const ws = await openSession(session, lastWs);
    await speak(session);
    expect(realtime(ws)[0]).toEqual({ activityStart: {} });
    expect(realtime(ws).at(-1)).toEqual({ activityEnd: {} });
  });

  test('hands-free with no gate is refused loudly, not run as a plain call', async () => {
    const { deps, audioEvents } = makeDeps();
    const onFatal = vi.fn();
    const session = new GeminiLiveSession(makeInit({ mode: 'hands-free' }), { ...deps, onFatal });
    session.onSessionStart();
    expect(onFatal).toHaveBeenCalled();
    expect(audioEvents).toContainEqual(expect.objectContaining({ type: 'audio.error' }));
  });
});
