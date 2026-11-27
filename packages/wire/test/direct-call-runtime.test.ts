import { describe, expect, it, vi } from 'vitest';
import {
  startDirectCall,
  type DirectCallEngines,
  type DirectCallStatus,
  type PreparedSpeech,
} from '../src/direct-call-runtime.js';

const RATE = 16000;
/** `ms` of a loud tone or of silence, in 20 ms frames. */
function frames(ms: number, loud: boolean): Int16Array[] {
  const out: Int16Array[] = [];
  for (let t = 0; t < ms; t += 20) {
    const f = new Int16Array((RATE * 20) / 1000);
    if (loud) for (let i = 0; i < f.length; i++) f[i] = Math.round(8000 * Math.sin(i / 3));
    out.push(f);
  }
  return out;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(over: Partial<DirectCallEngines> = {}, detectTurns = true) {
  const sent: string[] = [];
  const statuses: DirectCallStatus[] = [];
  const played: string[] = [];
  const stopped: string[] = [];
  const plays: Array<() => void> = [];
  const engines: DirectCallEngines = {
    stt: { label: 'Parakeet', transcribe: vi.fn(async () => 'hello there friend') },
    tts: {
      label: 'Kokoro',
      prepare: vi.fn(async (text: string): Promise<PreparedSpeech> => {
        let done: () => void = () => {};
        return {
          play: () =>
            new Promise<void>((r) => {
              played.push(text);
              done = r;
              plays.push(r);
            }),
          stop: () => {
            stopped.push(text);
            done();
          },
        };
      }),
    },
    turn: { label: 'Smart Turn', probability: vi.fn(async () => 0.9) },
    ...over,
  };
  const call = startDirectCall(
    engines,
    {
      sendTurn: async (t) => void sent.push(t),
      longPauseMs: 3000,
      detectTurns,
      now: () => 1000,
    },
    (s) => statuses.push(s),
  );
  const say = (ms: number) => frames(ms, true).forEach((f) => call.pushPcm(f));
  const quiet = (ms: number) => frames(ms, false).forEach((f) => call.pushPcm(f));
  return { call, engines, sent, statuses, played, stopped, plays, say, quiet };
}

describe('direct call runtime', () => {
  it('Smart Turn at a short pause ends the utterance, which is read and sent', async () => {
    const h = harness();
    h.quiet(200);
    h.say(1500);
    h.quiet(800);
    await flush();
    await flush();
    expect(h.engines.turn.probability).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual(['hello there friend']);
  });

  it('an unfinished verdict keeps listening; the long pause ends it anyway', async () => {
    const h = harness({ turn: { label: 'Smart Turn', probability: async () => 0.1 } });
    h.quiet(200);
    h.say(1500);
    h.quiet(800);
    await flush();
    expect(h.sent).toEqual([]);
    h.quiet(2500);
    await flush();
    await flush();
    expect(h.sent).toEqual(['hello there friend']);
  });

  it('with detection off only the long pause decides', async () => {
    const h = harness({}, false);
    h.quiet(200);
    h.say(1500);
    h.quiet(1000);
    await flush();
    expect(h.engines.turn.probability).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    h.quiet(2200);
    await flush();
    await flush();
    expect(h.sent).toEqual(['hello there friend']);
  });

  it('utterances are sent in the order spoken even when reads finish out of order', async () => {
    let n = 0;
    const resolvers: Array<(t: string) => void> = [];
    const h = harness({
      stt: {
        label: 'Groq Whisper',
        transcribe: () => new Promise<string>((r) => resolvers.push(r)),
      },
    });
    h.quiet(200);
    h.say(1200);
    h.quiet(800);
    await flush();
    h.say(1200);
    h.quiet(800);
    await flush();
    expect(resolvers.length).toBe(2);
    resolvers[1]!(`second thing ${++n}`);
    resolvers[0]!('first thing to say');
    await flush();
    await flush();
    expect(h.sent).toEqual(['first thing to say', 'second thing 1']);
  });

  it('a failed engine shows naming it, the call stays open, and its next success clears it', async () => {
    let fail = true;
    const h = harness({
      stt: {
        label: 'Groq Whisper',
        transcribe: async () => {
          if (fail) throw new Error('HTTP 429 — rate limited');
          return 'it worked this time';
        },
      },
    });
    h.quiet(200);
    h.say(1200);
    h.quiet(800);
    await flush();
    await flush();
    expect(h.call.status().failure).toBe('Groq Whisper failed — HTTP 429 — rate limited');
    expect(h.sent).toEqual([]);
    fail = false;
    h.say(1200);
    h.quiet(800);
    await flush();
    await flush();
    expect(h.sent).toEqual(['it worked this time']);
    expect(h.call.status().failure).toBeNull();
  });

  it('the agent working shows on the line until the reply, which is read aloud piece by piece', async () => {
    const h = harness();
    h.call.setAgentWorking(true, 500);
    expect(h.call.status()).toMatchObject({ line: 'working', workingSince: 500 });
    h.call.setAgentWorking(false);
    h.call.agentReplied(
      'This first sentence is long enough to be spoken on its own. And here is the second one.',
    );
    await flush();
    await flush();
    expect(h.played).toEqual(['This first sentence is long enough to be spoken on its own.']);
    expect(h.call.status().line).toBe('speaking');
    // The next piece was made while the first played.
    expect(h.engines.tts.prepare).toHaveBeenCalledTimes(2);
    h.plays[0]!();
    await flush();
    await flush();
    expect(h.played[1]).toBe('And here is the second one.');
    h.plays[1]!();
    await flush();
    await flush();
    expect(h.call.status().line).toBe('listening');
  });

  it('barge-in: speech while reading stops it and the rest is not read', async () => {
    const h = harness();
    h.call.agentReplied(
      'This first sentence is long enough to be spoken on its own. And here is the second one.',
    );
    await flush();
    await flush();
    expect(h.played.length).toBe(1);
    h.quiet(100);
    h.say(300);
    await flush();
    await flush();
    expect(h.stopped).toEqual(['This first sentence is long enough to be spoken on its own.']);
    expect(h.played.length).toBe(1);
    expect(h.call.status().line).toBe('hearing');
  });

  it('a failed voice shows naming the text-to-speech engine', async () => {
    const h = harness({
      tts: {
        label: 'ElevenLabs',
        prepare: async () => {
          throw new Error('no ElevenLabs key is set on this host');
        },
      },
    });
    h.call.agentReplied('Done.');
    await flush();
    await flush();
    expect(h.call.status().failure).toBe(
      'ElevenLabs failed — no ElevenLabs key is set on this host',
    );
  });

  it('muted or ended, nothing is heard or sent', async () => {
    const h = harness();
    h.call.setMuted(true);
    h.quiet(200);
    h.say(1200);
    h.quiet(4000);
    await flush();
    expect(h.sent).toEqual([]);
    h.call.setMuted(false);
    h.call.end();
    h.say(1200);
    h.quiet(4000);
    await flush();
    expect(h.sent).toEqual([]);
  });
});

describe('cloud engines', () => {
  it('base64 round-trips every byte length', async () => {
    const { bytesToBase64, base64ToBytes } = await import('../src/direct-call-runtime.js');
    for (const n of [0, 1, 2, 3, 4, 5, 255]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) & 255);
      const b64 = bytesToBase64(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString('base64'));
      expect([...base64ToBytes(b64)]).toEqual([...bytes]);
    }
  });

  it('read and speak through the chat’s host, on the chosen engine', async () => {
    const { cloudSpeechToText, cloudTextToSpeech } = await import('../src/direct-call-runtime.js');
    const posts: [string, Record<string, unknown>][] = [];
    const post = async <T>(path: string, body: object): Promise<T> => {
      posts.push([path, body as Record<string, unknown>]);
      return (
        path.endsWith('transcribe')
          ? { transcript: 'hi' }
          : { pcmBase64: Buffer.from([1, 0, 2, 0]).toString('base64'), sampleRate: 24000 }
      ) as T;
    };
    const stt = cloudSpeechToText({ post, chatId: 'c1', engine: 'groq', model: 'm' });
    expect(stt.label).toBe('Groq Whisper');
    expect(await stt.transcribe(new Int16Array([1, 2]))).toBe('hi');
    const wav = Buffer.from(posts[0]![1]['audioBase64'] as string, 'base64');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16000);
    let got: Int16Array | null = null;
    const tts = cloudTextToSpeech({
      post,
      chatId: 'c1',
      engine: 'openai',
      model: 'tts-1',
      voice: 'alloy',
      sound: { speed: 1 },
      play: (pcm) => {
        got = pcm;
        return { play: async () => {}, stop: () => {} };
      },
    });
    await tts.prepare('Hello.');
    expect(posts[1]).toEqual([
      '/api/voice/direct/speak',
      {
        chatId: 'c1',
        engine: 'openai',
        model: 'tts-1',
        voice: 'alloy',
        sound: { speed: 1 },
        text: 'Hello.',
      },
    ]);
    expect([...got!]).toEqual([1, 2]);
  });
});
