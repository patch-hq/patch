// Dictation on the `host` engine (spec/07 § Dictation engines): a streaming
// recogniser makes the live words, each finished phrase is read once by the
// accurate transcriber and swapped in place, and the final is those reads
// joined. Driven with stand-ins for both models.

import { describe, expect, test } from 'vitest';
import pino from 'pino';
import type { AudioEvent } from '@patch/wire/audio';
import { HostDictationSession } from '../src/audio/host-dictation.js';
import type { LiveEvent, LiveRecognizer, LiveStream } from '../src/audio/parakeet-live.js';
import type { WhisperBackend } from '../src/audio/whisper.js';

const logger = pino({ level: 'silent' });
const SECOND = 16000;

function fakeLive() {
  let emit!: (ev: LiveEvent) => void;
  const fed: number[] = [];
  let finishImpl: () => Promise<void> = async () => undefined;
  let closed = false;
  const live: LiveRecognizer = {
    warm: async () => undefined,
    close: async () => undefined,
    open(onEvent) {
      emit = onEvent;
      const stream: LiveStream = {
        accept: (pcm) => void fed.push(pcm.length),
        finish: () => finishImpl(),
        close: () => void (closed = true),
      };
      return stream;
    },
  };
  return {
    live,
    emit: (ev: LiveEvent) => emit(ev),
    fed,
    onFinish: (f: () => Promise<void>) => void (finishImpl = f),
    isClosed: () => closed,
  };
}

function fakeAccurate(read: (pcm: Int16Array) => Promise<string>): {
  backend: WhisperBackend;
  reads: number[];
} {
  const reads: number[] = [];
  const backend = {
    supportsLivePartials: false,
    transcribe: async (pcm: Int16Array) => {
      reads.push(pcm.length);
      return read(pcm);
    },
    transcribeClip: async () => '',
    close: async () => undefined,
  } as WhisperBackend;
  return { backend, reads };
}

function setup(read: (pcm: Int16Array) => Promise<string>) {
  const sent: AudioEvent[] = [];
  const l = fakeLive();
  const a = fakeAccurate(read);
  const session = new HostDictationSession(
    { sessionId: 's1', chatId: 'c1' },
    { logger, sendAudio: (e) => sent.push(e), live: l.live, accurate: a.backend },
  );
  session.onSessionStart();
  const partials = (): string[] =>
    sent
      .filter((e) => e.type === 'audio.transcript_partial')
      .map((e) => (e as { text: string }).text);
  const finals = (): string[] =>
    sent
      .filter((e) => e.type === 'audio.transcript_final')
      .map((e) => (e as { text: string }).text);
  const errors = (): AudioEvent[] => sent.filter((e) => e.type === 'audio.error');
  return { session, l, a, sent, partials, finals, errors };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('HostDictationSession', () => {
  test('says it is listening and gives every mic chunk to the streaming recogniser once', async () => {
    const t = setup(async () => 'x');
    expect(t.sent[0]).toMatchObject({ type: 'audio.state', state: 'listening' });
    await t.session.onMicFrame(new Int16Array(1600));
    await t.session.onMicFrame(new Int16Array(800));
    expect(t.l.fed).toEqual([1600, 800]);
  });

  test('live words show as they are spoken; a finished phrase is read once and replaced in place', async () => {
    const t = setup(async () => 'Hello, world.');
    await t.session.onMicFrame(new Int16Array(2 * SECOND));
    t.l.emit({ type: 'text', text: 'hello' });
    t.l.emit({ type: 'text', text: 'hello world' });
    expect(t.partials()).toEqual(['hello', 'hello world']);
    t.l.emit({ type: 'phrase', text: 'hello world', startSample: 0, endSample: 2 * SECOND });
    await tick();
    expect(t.a.reads).toHaveLength(1);
    expect(t.partials().at(-1)).toBe('Hello, world.');
  });

  test('the phrase read covers its own audio plus a quarter-second either side', async () => {
    const t = setup(async () => 'ok');
    await t.session.onMicFrame(new Int16Array(5 * SECOND));
    t.l.emit({ type: 'phrase', text: 'a', startSample: 1 * SECOND, endSample: 3 * SECOND });
    await tick();
    expect(t.a.reads).toEqual([2.5 * SECOND]);
  });

  test('stopping waits for the last phrase read and the final is the reads joined, never the live words', async () => {
    let n = 0;
    const t = setup(async () => {
      const mine = n++;
      await tick(mine === 1 ? 300 : 0); // the last phrase is slow
      return mine === 0 ? 'First phrase.' : 'Second phrase.';
    });
    await t.session.onMicFrame(new Int16Array(6 * SECOND));
    t.l.emit({ type: 'phrase', text: 'first phrase', startSample: 0, endSample: 2 * SECOND });
    t.l.emit({ type: 'text', text: 'second phrase' });
    t.l.onFinish(async () => {
      t.l.emit({
        type: 'phrase',
        text: 'second phrase',
        startSample: 3 * SECOND,
        endSample: 5 * SECOND,
      });
    });
    await t.session.finishDictation();
    expect(t.finals()).toEqual(['First phrase. Second phrase.']);
    expect(t.errors()).toEqual([]);
  });

  test('a failed accurate read is reported once and that phrase keeps its live words', async () => {
    const t = setup(async () => {
      throw new Error('model gone');
    });
    await t.session.onMicFrame(new Int16Array(6 * SECOND));
    t.l.emit({ type: 'phrase', text: 'one', startSample: 0, endSample: SECOND });
    t.l.emit({ type: 'phrase', text: 'two', startSample: 2 * SECOND, endSample: 3 * SECOND });
    t.l.onFinish(async () => undefined);
    await t.session.finishDictation();
    expect(t.finals()).toEqual(['one two']);
    expect(t.errors()).toHaveLength(1);
    expect(t.errors()[0]).toMatchObject({ code: 'whisper_unavailable' });
  });

  test('a streaming recogniser that fails fails the dictation: an error, no final, no other engine', async () => {
    const t = setup(async () => 'x');
    t.l.emit({ type: 'error', message: 'model would not load' });
    await t.session.finishDictation();
    expect(t.errors()).toHaveLength(1);
    expect(t.errors()[0]).toMatchObject({ code: 'whisper_unavailable' });
    expect(t.finals()).toEqual([]);
  });

  test('closing releases the stream, and nothing is sent after', async () => {
    const t = setup(async () => 'x');
    await t.session.close();
    expect(t.l.isClosed()).toBe(true);
    const before = t.sent.length;
    t.l.emit({ type: 'text', text: 'late' });
    await t.session.onMicFrame(new Int16Array(100));
    expect(t.sent.length).toBe(before);
  });
});
