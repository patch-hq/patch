// A whole voice call, end to end, with only Gemini and the agent's model faked:
// the surface's audio socket, the real audio server, the real Gemini session,
// the real chat host (history log, turn queue, spend bookkeeping) and the real
// call-costing glue. What each test asserts is what the user sees: the banner the
// call leaves in the chat and the cost on it.
//
// These exist because the cost on that banner was wrong ($4.33 for two
// requests: a long unrelated turn finishing mid-call was charged to the call)
// and no test drove a call through the real pieces to notice.

import {
  DEFAULT_SHARED_SETTINGS,
  DEFAULT_VOICE_RELAY_HANDOFF_ANSWER,
  DEFAULT_VOICE_RELAY_UNPROMPTED,
  relayFrom,
} from '@patch/wire';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { WebSocket } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import type { WireEvent } from '@patch/wire';
import { encodeAudio, DEFAULT_VOICE_CONFIG, type VoiceConfig } from '@patch/wire/audio';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createClaudeSessionProbe } from '../src/history.js';
import { createChatVoice } from '../src/audio/chatVoice.js';
import { createVoiceReplyBridge } from '../src/audio/replyBridge.js';
import { createVoiceLedger } from '../src/audio/voiceLedger.js';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createWhisper } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import { MockVad } from '../src/audio/vad.js';
import { DEFAULT_VOICE_INSTRUCTIONS } from '@patch/wire';
import { PASS_TO_AGENT_TOOL_NAME } from '../src/audio/voiceAgent.js';

const SECRET = 'integration-test-internal-token-aaaaaaa';
const silent = pino({ level: 'silent' });
/** What the fake harness reports each agent turn cost. */
const COST_PER_TURN = 0.2;

/** The Gemini end of the call: the test plays the model, frame by frame. */
class FakeGemini extends EventEmitter {
  sent: string[] = [];
  constructor(public readonly url: string) {
    super();
  }
  send(data: string): void {
    this.sent.push(data);
    if ((JSON.parse(data) as { setup?: unknown }).setup) {
      queueMicrotask(() => this.emit('message', JSON.stringify({ setupComplete: {} }), false));
    }
  }
  close(): void {}
  say(msg: unknown): void {
    this.emit('message', JSON.stringify(msg), false);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function speech(): unknown {
  const pcm = new Int16Array([1, 2]);
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
  return { serverContent: { modelTurn: { parts: [{ inlineData: { data } }] } } };
}

function mintToken(sessionId: string, chatId: string): string {
  const claims = Buffer.from(
    JSON.stringify({
      accountId: 'a',
      surfaceId: 'surf',
      sessionId,
      chatId,
      exp: Date.now() + 60_000,
      jti: `jti-${randomUUID()}`,
    }),
    'utf8',
  ).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(claims).digest().toString('base64url');
  return `${claims}.${sig}`;
}

function world(voiceConfig?: Partial<VoiceConfig>) {
  const home = mkdtempSync(join(tmpdir(), 'patch-call-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-call-folder-')));
  const events: WireEvent[] = [];
  let id = 0;
  // Every agent turn waits on this gate before it settles; tests hold and release it.
  let release: () => void = () => undefined;
  let gate: Promise<void> = Promise.resolve();
  const hold = (): void => {
    gate = new Promise((r) => {
      release = r;
    });
  };
  let observe: (e: WireEvent) => void = () => undefined;
  let drawnStarted: (chatId: string, localId: string) => void = () => undefined;
  const replies = createVoiceReplyBridge();
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: {
      run: async function* (opts: { prompt: string }) {
        // The reply names what it was asked, so a test can tell whose answer it is.
        const asked = opts.prompt.replace(/\s+/g, ' ').trim().slice(-30);
        yield { type: 'assistant' as const, content: `agent reply to: ${asked}`, sessionId: 'S1' };
        await gate;
        yield {
          type: 'result' as const,
          sessionId: 'S1',
          raw: { type: 'result', total_cost_usd: COST_PER_TURN },
        };
      },
    },
    oauthAccessToken: 'fake-token',
    emit: (e) => {
      events.push(e);
      observe(e);
    },
    logger: silent,
    now: () => Date.now(),
    generateChatId: () => `chat-${++id}`,
    onDrawnTurnStarted: (chatId, localId) => drawnStarted(chatId, localId),
    sessionProbe: createClaudeSessionProbe({
      sessionStoreRoot: mkdtempSync(join(tmpdir(), 'patch-call-claude-')),
    }),
  });
  let server: (AudioServerHandle & { port: number }) | undefined;
  const glue = createChatVoice({
    relayInstructions: () => relayFrom(DEFAULT_SHARED_SETTINGS),
    daemon,
    sessionsOnChat: (chatId) => server?.sessionsOnChat(chatId) ?? [],
    sessionById: (sessionId) => server?.sessionById(sessionId),
    endCall: (sessionId) => server!.endSession(sessionId),
    catchUp: async (_chatId, earlier) => `caught up on ${earlier.length} messages`,
    ledger: createVoiceLedger(join(home, 'voice-usage.jsonl')),
    logger: silent,
    onCosted: () => undefined,
  });
  observe = (e) => {
    glue.observe(e);
    replies.observe(e);
  };
  drawnStarted = (chatId, localId) => glue.handoffStarted({ chatId, handoffId: localId });
  const geminis: FakeGemini[] = [];
  const config: VoiceConfig = {
    ...DEFAULT_VOICE_CONFIG,
    ...voiceConfig,
  };
  const start = async (): Promise<void> => {
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger: silent,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger: silent }),
      kokoro: createKokoro({ backend: 'mock', logger: silent }),
      makeVad: () => new MockVad(),
      chatExists: (chatId) => chatId.startsWith('chat-'),
      getVoiceConfig: () => config,
      geminiApiKey: 'test-key',
      geminiWsCtor: function (url: string): FakeGemini {
        const g = new FakeGemini(url);
        queueMicrotask(() => g.emit('open'));
        geminis.push(g);
        return g;
      } as unknown as new (url: string) => WsSocket,
      makeTimeline: (init) => glue.makeTimeline(init),
      voiceAgentLink: glue.link,
      getVoiceInstructions: () => DEFAULT_VOICE_INSTRUCTIONS,
      // Only the local tier runs a turn per utterance; a voice agent call never does.
      submitUserTurn: async () => {
        throw new Error('a voice agent call does not submit turns itself');
      },
      onCallEnded: (info) => glue.callEnded(info),
    });
    server = Object.assign(handle, { port: handle.address().port });
  };
  const sockets: WebSocket[] = [];
  /** Pick up a call on `chatId` from a web surface; resolves once Gemini is on the line. */
  const call = async (chatId: string, resumes?: string) => {
    const sessionId = `s-${randomUUID()}`;
    const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/audio/${sessionId}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const before = geminis.length;
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId,
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId,
        role: 'voice-call',
        token: mintToken(sessionId, chatId),
        surfaceHasAec: true,
        ...(resumes !== undefined ? { resumes } : {}),
      }),
    );
    if (resumes !== undefined)
      return {
        closed: new Promise<string>((res) =>
          ws.once('close', (_c: number, r: Buffer) => res(r.toString())),
        ),
        geminiCount: () => geminis.length - before,
      };
    await vi.waitFor(() => expect(geminis.length).toBe(before + 1));
    const gemini = geminis[before]!;
    await vi.waitFor(() => expect(gemini.sent.length).toBeGreaterThan(0));
    return {
      gemini,
      hangUp: () => {
        ws.send(encodeAudio({ type: 'audio.session_end' }));
        ws.close();
      },
      /** Resolves with the close reason once the host closes the surface's socket. */
      closed: new Promise<string>((resolve) =>
        ws.once('close', (_code: number, reason: Buffer) => resolve(reason.toString())),
      ),
      /** The user speaks and the model decides to hand off to the agent. */
      handOff: (callId: string, request: string) => {
        gemini.say({ serverContent: { inputTranscription: { text: request } } });
        gemini.say({
          toolCall: {
            functionCalls: [{ id: callId, name: PASS_TO_AGENT_TOOL_NAME, args: { request } }],
          },
        });
        gemini.say(speech());
        gemini.say({ serverContent: { turnComplete: true } });
      },
    };
  };
  const banners = (): string[] =>
    events
      .filter(
        (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
          e.type === 'chat.message' && e.role === 'system' && e.content.startsWith('[call]'),
      )
      .map((e) => e.content);
  return {
    daemon,
    folder,
    start,
    call,
    hold,
    release: () => release(),
    banners,
    close: async () => {
      for (const s of sockets) s.close();
      await server?.close();
    },
  };
}

const typed = (daemon: Daemon, chatId: string) =>
  daemon.sendInput({ chatId, message: 'typed work', localId: randomUUID() });

describe('a voice call, end to end', () => {
  let w: ReturnType<typeof world>;
  afterEach(async () => {
    w.release();
    await w.close();
  });

  async function begin(): Promise<string> {
    w = world();
    await w.start();
    return w.daemon.spawnChat({ folder: w.folder });
  }
  const results = (c: { gemini: FakeGemini }): string[] =>
    c.gemini
      .frames()
      .flatMap((f) =>
        'clientContent' in f
          ? [
              (f['clientContent'] as { turns: Array<{ parts: Array<{ text: string }> }> }).turns[0]!
                .parts[0]!.text,
            ]
          : [],
      );

  it('hands off twice, gets both answers back as messages, and leaves a banner costing the voice alone', async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    c.handOff('c1', 'list the files');
    await vi.waitFor(() => expect(results(c)).toHaveLength(1));
    expect(results(c)[0]).toContain('agent reply to: ');
    expect(results(c)[0]).toContain('list the files');
    c.gemini.say(speech()); // the voice says the answer
    c.gemini.say({ serverContent: { turnComplete: true } });
    c.handOff('c2', 'what is on my calendar');
    await vi.waitFor(() => expect(results(c)).toHaveLength(2));
    c.hangUp();
    await vi.waitFor(() => expect(w.banners()).toHaveLength(1));
    // Two agent turns ran, at $0.20 each; neither is on the banner.
    expect(w.banners()[0]).toMatch(/^\[call\] Call 0:\d\d · Gemini Flash · \$0/);
    expect(w.banners()[0]).not.toMatch(/agent|\$0\.[2-9]/);
  });

  it('shows the banner the moment you hang up, even with an unrelated turn still running', async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    w.hold();
    const work = typed(w.daemon, chatId);
    await vi.waitFor(() => expect(w.daemon.isTurnRunning(chatId)).toBe(true));
    c.hangUp();
    await vi.waitFor(() => expect(w.banners()).toHaveLength(1));
    w.release();
    await work;
    expect(w.banners()).toHaveLength(1);
  });

  it("shows the banner the moment you hang up, even with the call's own hand-off still running", async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    w.hold();
    c.handOff('c1', 'do a long job');
    await vi.waitFor(() => expect(w.daemon.isTurnRunning(chatId)).toBe(true));
    c.hangUp();
    await vi.waitFor(() => expect(w.banners()).toHaveLength(1));
    expect(w.banners()[0]).not.toMatch(/agent/);
  });

  it('says a hand-off answer to a call whose model was mid-sentence only once it has finished', async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    w.hold();
    c.handOff('c1', 'list the files');
    // The user keeps talking while the agent works.
    c.gemini.say({ serverContent: { inputTranscription: { text: 'and also' } } });
    w.release();
    await new Promise((r) => setTimeout(r, 150));
    expect(results(c)).toHaveLength(0);
    c.gemini.say(speech());
    c.gemini.say({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(results(c)).toHaveLength(1));
  });

  it("a hand-off queued behind other work is answered with its own turn's text, not the other turn's", async () => {
    const chatId = await begin();
    w.hold();
    const work = typed(w.daemon, chatId);
    await vi.waitFor(() => expect(w.daemon.isTurnRunning(chatId)).toBe(true));
    const c = await w.call(chatId);
    c.handOff('c1', 'check the weather');
    await new Promise((r) => setTimeout(r, 100));
    // The typed turn finishes first; the call's answer must wait for its own turn.
    w.release();
    await work;
    // The typed turn's reply is pushed as news, and the voice says it; then comes the
    // answer, which is its own turn's text.
    await vi.waitFor(() => expect(results(c).length).toBeGreaterThan(0));
    c.gemini.say(speech());
    c.gemini.say({ serverContent: { turnComplete: true } });
    let answer: string | undefined;
    await vi.waitFor(() => {
      answer = results(c).find((t) => t.startsWith(DEFAULT_VOICE_RELAY_HANDOFF_ANSWER));
      expect(answer).toBeDefined();
    });
    expect(answer).toContain('check the weather');
    expect(answer).not.toContain('typed work');
    expect(results(c).some((t) => t.startsWith(DEFAULT_VOICE_RELAY_UNPROMPTED))).toBe(true);
  });

  it('look_back answers from what is actually in the chat, and from nothing else', async () => {
    const chatId = await begin();
    w.daemon.recordVoiceMessage({ chatId, role: 'user', content: 'why did the chat get archived' });
    w.daemon.recordVoiceMessage({
      chatId,
      role: 'assistant',
      content: 'a client on your IP sent the archive request',
    });
    w.daemon.recordVoiceMessage({ chatId, role: 'user', content: 'what is the weather' });
    const c = await w.call(chatId);
    const ask = async (id: string, query: string): Promise<string> => {
      c.gemini.say({
        toolCall: { functionCalls: [{ id, name: 'look_back', args: { query } }] },
      });
      let frame: Record<string, unknown> | undefined;
      await vi.waitFor(() => {
        frame = c.gemini
          .frames()
          .find(
            (f) =>
              'toolResponse' in f &&
              JSON.stringify(f).includes(`"id":"${id}"`) &&
              JSON.stringify(f).includes('"name":"look_back"'),
          );
        expect(frame).toBeDefined();
      });
      return JSON.stringify(frame);
    };
    const hit = await ask('lb-1', 'archived');
    expect(hit).toContain('why did the chat get archived');
    expect(hit).not.toContain('weather');
    expect(await ask('lb-2', 'zebra')).toContain('Nothing in this chat matches');
    // Nothing of this ran an agent turn or cost the call anything but its voice.
    c.hangUp();
    await vi.waitFor(() => expect(w.banners()).toHaveLength(1));
  });

  it('a typed turn that ends during the call is pushed in; check status reads the host', async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    w.hold();
    c.handOff('c1', 'list the files');
    await vi.waitFor(() => expect(w.daemon.isTurnRunning(chatId)).toBe(true));
    c.gemini.say({ toolCall: { functionCalls: [{ id: 's1', name: 'check_status', args: {} }] } });
    let status = '';
    await vi.waitFor(() => {
      const frame = c.gemini
        .frames()
        .find((f) => 'toolResponse' in f && JSON.stringify(f).includes('"id":"s1"'));
      expect(frame).toBeDefined();
      status = JSON.stringify(frame);
    });
    expect(status).toContain('list the files');
    expect(status).toContain('being worked on');
    expect(status).toContain("The chat's agent now: working");
    w.release();
    await vi.waitFor(() => expect(results(c)).toHaveLength(1));
    expect(results(c)[0]).toContain('Request: list the files');
    c.gemini.say(speech());
    c.gemini.say({ serverContent: { turnComplete: true } });
    // Typed into the chat from elsewhere while the call is open.
    await typed(w.daemon, chatId);
    await vi.waitFor(() => expect(results(c)).toHaveLength(2));
    expect(results(c)[1]).toContain(DEFAULT_VOICE_RELAY_UNPROMPTED);
    expect(results(c)[1]).toContain('typed work');
  });

  it('the call opens with the chat as it stands, and the catch-up follows as context', async () => {
    const chatId = await begin();
    for (const m of ['first', 'second', 'third']) {
      await w.daemon.sendInput({ chatId, message: m, localId: randomUUID() });
    }
    const c = await w.call(chatId);
    const setup = c.gemini.frames()[0] as {
      setup: { systemInstruction: { parts: Array<{ text: string }> } };
    };
    const instructions = setup.setup.systemInstruction.parts[0]!.text;
    expect(instructions.startsWith(DEFAULT_VOICE_INSTRUCTIONS)).toBe(true);
    expect(instructions).toContain('User: third');
    expect(instructions).not.toContain('User: first');
    await vi.waitFor(() => expect(results(c).some((t) => t.includes('caught up on'))).toBe(true));
  });

  it('the voice says goodbye and ends the call: a clean end, after the goodbye has played', async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    c.gemini.say({ serverContent: { inputTranscription: { text: 'that is all, bye' } } });
    c.gemini.say(speech()); // "Bye!"
    c.gemini.say({ toolCall: { functionCalls: [{ id: 'e1', name: 'end_call', args: {} }] } });
    c.gemini.say({ serverContent: { turnComplete: true } });
    await expect(c.closed).resolves.toBe('ended_by_agent');
    await vi.waitFor(() => expect(w.banners()).toHaveLength(1));
  });

  it('a redial just after the agent hung up is ended, not given a new call', async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    c.gemini.say(speech());
    c.gemini.say({ toolCall: { functionCalls: [{ id: 'e1', name: 'end_call', args: {} }] } });
    c.gemini.say({ serverContent: { turnComplete: true } });
    await expect(c.closed).resolves.toBe('ended_by_agent');
    const r = (await w.call(chatId, 'gone')) as {
      closed: Promise<string>;
      geminiCount: () => number;
    };
    await expect(r.closed).resolves.toBe('ended_by_agent');
    expect(r.geminiCount()).toBe(0);
  });

  it('leaves a banner for a call that handed nothing off', async () => {
    const chatId = await begin();
    const c = await w.call(chatId);
    c.gemini.say({ serverContent: { inputTranscription: { text: 'what is a nebula' } } });
    c.gemini.say(speech());
    c.gemini.say({ serverContent: { turnComplete: true } });
    c.hangUp();
    await vi.waitFor(() => expect(w.banners()).toHaveLength(1));
    expect(w.banners()[0]).toMatch(/Gemini Flash/);
  });
});
