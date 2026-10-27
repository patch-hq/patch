// Dictation on the `deepgram` engine (spec/07 § Dictation engines): the live
// words stream back as they are spoken and ARE the transcript, and with tidy-up
// on each finished phrase is read once by Whisper and swapped in place.
// Driven against a local stand-in for Deepgram's streaming endpoint.

import { afterEach, describe, expect, test } from 'vitest';
import pino from 'pino';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AudioEvent } from '@patch/wire/audio';
import { DeepgramDictationSession } from '../src/audio/deepgram-dictation.js';
import type { WhisperBackend } from '../src/audio/whisper.js';

const logger = pino({ level: 'silent' });

interface FakeDeepgram {
  url: string;
  socket: () => Promise<WsSocket>;
  received: { binary: number; control: string[]; headers: Record<string, string | undefined> };
  close: () => Promise<void>;
}

async function fakeDeepgram(
  onControl?: (sock: WsSocket, msg: { type: string }) => void,
): Promise<FakeDeepgram> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const received: FakeDeepgram['received'] = { binary: 0, control: [], headers: {} };
  let resolveSock!: (s: WsSocket) => void;
  const sockP = new Promise<WsSocket>((r) => (resolveSock = r));
  wss.on('connection', (sock, req) => {
    received.headers.authorization = req.headers.authorization;
    received.headers.url = req.url;
    sock.on('message', (data, isBinary) => {
      if (isBinary) {
        received.binary += 1;
        return;
      }
      const msg = JSON.parse(String(data)) as { type: string };
      received.control.push(msg.type);
      onControl?.(sock, msg);
    });
    resolveSock(sock);
  });
  const port = (wss.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}/v1/listen`,
    socket: () => sockP,
    received,
    close: () => new Promise((r) => wss.close(() => r())),
  };
}

function result(
  transcript: string,
  o: {
    start: number;
    duration: number;
    isFinal?: boolean;
    speechFinal?: boolean;
    fromFinalize?: boolean;
  },
): string {
  return JSON.stringify({
    type: 'Results',
    start: o.start,
    duration: o.duration,
    is_final: o.isFinal ?? false,
    speech_final: o.speechFinal ?? false,
    ...(o.fromFinalize ? { from_finalize: true } : {}),
    channel: { alternatives: [{ transcript }] },
  });
}

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await tick(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const partials = (audio: AudioEvent[]): string[] =>
  audio.flatMap((e) => (e.type === 'audio.transcript_partial' ? [e.text] : []));
const finals = (audio: AudioEvent[]): string[] =>
  audio.flatMap((e) => (e.type === 'audio.transcript_final' ? [e.text] : []));

function whisper(
  answer: (pcm: Int16Array) => Promise<string>,
): WhisperBackend & { calls: Int16Array[] } {
  const calls: Int16Array[] = [];
  return {
    calls,
    supportsLivePartials: false,
    async transcribe(pcm) {
      calls.push(pcm);
      return answer(pcm);
    },
    async transcribeClip() {
      return '';
    },
    async close() {},
  };
}

const ONE_SECOND = 16000;
let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

async function open(opts: {
  tidyWith?: WhisperBackend;
  onControl?: Parameters<typeof fakeDeepgram>[0];
}) {
  const dg = await fakeDeepgram(opts.onControl);
  const audio: AudioEvent[] = [];
  const session = new DeepgramDictationSession(
    { sessionId: 's1', chatId: 'c1' },
    {
      logger,
      apiKey: 'dg-test-key-0000000000',
      sendAudio: (e) => audio.push(e),
      wsUrl: dg.url,
      ...(opts.tidyWith ? { tidyWith: opts.tidyWith } : {}),
    },
  );
  cleanup.push(async () => {
    await session.close();
    await dg.close();
  });
  session.onSessionStart();
  return { dg, audio, session };
}

describe('Deepgram dictation — the live words are the transcript', () => {
  test('streams the mic and shows every word as it arrives, interim then final', async () => {
    const { dg, audio, session } = await open({});
    // Audio sent before the socket opened is held and flushed, not lost.
    await session.onMicFrame(new Int16Array(640));
    const sock = await dg.socket();
    await session.onMicFrame(new Int16Array(640));
    await until(() => dg.received.binary === 2, 'both frames at Deepgram');
    expect(dg.received.headers.authorization).toBe('Token dg-test-key-0000000000');
    expect(dg.received.headers.url).toContain('interim_results=true');
    expect(dg.received.headers.url).toContain('encoding=linear16');

    sock.send(result('buy oat', { start: 0, duration: 0.8 }));
    sock.send(result('buy oat milk', { start: 0, duration: 1.2, isFinal: true }));
    sock.send(result('and', { start: 1.2, duration: 0.3 }));
    await until(() => partials(audio).length === 3, 'three partials');
    expect(partials(audio)).toEqual(['buy oat', 'buy oat milk', 'buy oat milk and']);
  });

  test('finishing flushes Deepgram and answers with the whole dictation, nothing re-transcribed', async () => {
    const { dg, audio, session } = await open({
      onControl: (sock, msg) => {
        if (msg.type === 'Finalize') {
          sock.send(
            result('and some bread', {
              start: 1.2,
              duration: 1,
              isFinal: true,
              fromFinalize: true,
            }),
          );
        }
      },
    });
    const sock = await dg.socket();
    await session.onMicFrame(new Int16Array(640));
    sock.send(result('buy oat milk', { start: 0, duration: 1.2, isFinal: true }));
    sock.send(result('and some', { start: 1.2, duration: 0.5 }));
    await until(() => partials(audio).length === 2, 'partials');
    await session.finishDictation();
    expect(dg.received.control).toContain('Finalize');
    expect(finals(audio)).toEqual(['buy oat milk and some bread']);
  });

  test('words Deepgram never finalised before the flush times out still land', async () => {
    // Deepgram never answers the flush.
    const { dg, audio, session } = await open({});
    const sock = await dg.socket();
    await session.onMicFrame(new Int16Array(640));
    sock.send(result('hello there', { start: 0, duration: 1 }));
    await until(() => partials(audio).length === 1, 'partial');
    await session.finishDictation();
    expect(finals(audio)).toEqual(['hello there']);
  });

  test('a connection Deepgram refuses fails the dictation loudly', async () => {
    const audio: AudioEvent[] = [];
    const session = new DeepgramDictationSession(
      { sessionId: 's1', chatId: 'c1' },
      {
        logger,
        apiKey: 'dg-test-key-0000000000',
        sendAudio: (e) => audio.push(e),
        wsUrl: 'ws://127.0.0.1:1/v1/listen',
      },
    );
    cleanup.push(() => session.close());
    session.onSessionStart();
    await until(() => audio.some((e) => e.type === 'audio.error'), 'an error');
    const err = audio.find((e) => e.type === 'audio.error');
    expect(err).toMatchObject({ code: 'deepgram_unavailable' });
    // Nothing more is said for a failed session — no final that looks like success.
    await session.finishDictation();
    expect(finals(audio)).toEqual([]);
  });

  test('Deepgram closing mid-dictation is a failure, not a quiet end', async () => {
    const { dg, audio, session } = await open({});
    const sock = await dg.socket();
    await session.onMicFrame(new Int16Array(640));
    sock.close(1011, 'internal');
    await until(() => audio.some((e) => e.type === 'audio.error'), 'an error');
    expect(audio.find((e) => e.type === 'audio.error')).toMatchObject({
      code: 'deepgram_unavailable',
    });
  });
});

describe('Deepgram dictation — tidy-up with Whisper as it goes', () => {
  test('each finished phrase is read by Whisper and swapped in place while the next goes on', async () => {
    const w = whisper(async () => 'Buy oat milk.');
    const { dg, audio, session } = await open({ tidyWith: w });
    const sock = await dg.socket();
    // Two seconds of audio, so the phrase's own stretch can be cut out of it.
    await session.onMicFrame(new Int16Array(2 * ONE_SECOND));
    await until(() => dg.received.binary === 1, 'audio at Deepgram');
    sock.send(result('by oat milk', { start: 0.5, duration: 1, isFinal: true, speechFinal: true }));
    sock.send(result('and', { start: 1.8, duration: 0.2 }));
    await until(() => partials(audio).includes('Buy oat milk. and'), 'the tidied phrase');
    // Whisper heard the phrase's own audio, padded at both edges — not the whole stream.
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.length).toBe(Math.round((1 + 2 * 0.25) * ONE_SECOND));
  });

  test('a finish waits for the last phrase to be tidied', async () => {
    const w = whisper(async () => {
      await tick(100);
      return 'And some bread.';
    });
    const { dg, audio, session } = await open({
      tidyWith: w,
      onControl: (sock, msg) => {
        if (msg.type === 'Finalize') {
          sock.send(
            result('and sum bread', { start: 0, duration: 1, isFinal: true, fromFinalize: true }),
          );
        }
      },
    });
    await dg.socket();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await session.finishDictation();
    expect(finals(audio)).toEqual(['And some bread.']);
  });

  test('a failed tidy-up is reported once and the live words stand', async () => {
    const w = whisper(async () => {
      throw new Error('groq whisper 500');
    });
    const { dg, audio, session } = await open({ tidyWith: w });
    const sock = await dg.socket();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    sock.send(result('first bit', { start: 0, duration: 0.4, isFinal: true, speechFinal: true }));
    sock.send(
      result('second bit', { start: 0.5, duration: 0.4, isFinal: true, speechFinal: true }),
    );
    await until(() => w.calls.length === 2, 'two tidy-ups');
    await tick();
    const errors = audio.filter((e) => e.type === 'audio.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'whisper_unavailable' });
    expect(partials(audio).at(-1)).toBe('first bit second bit');
  });

  test('tidy-up off: Whisper is never asked', async () => {
    const { dg, audio, session } = await open({});
    const sock = await dg.socket();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    sock.send(result('as said', { start: 0, duration: 0.5, isFinal: true, speechFinal: true }));
    await until(() => partials(audio).length === 1, 'partial');
    expect(partials(audio)).toEqual(['as said']);
  });
});
