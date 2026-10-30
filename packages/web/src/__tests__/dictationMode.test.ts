import { describe, expect, it, vi } from 'vitest';
import { startDictationMode, pcm16ToWavBlob } from '../lib/dictationMode.js';
import type { VoiceRecording } from '../lib/voiceRecorder.js';

const FRAME = 640;
const speech = (): Int16Array => new Int16Array(FRAME).fill(6000);
const quiet = (): Int16Array => new Int16Array(FRAME);

function fakeRecorder() {
  let pcmCb: ((p: Int16Array) => void) | null = null;
  let silentCb: ((reason: string) => void) | null = null;
  const cancel = vi.fn();
  const rec: VoiceRecording = {
    onLevel: () => {},
    onSilent: (cb) => {
      silentCb = cb;
    },
    onPcm: (cb) => {
      pcmCb = cb;
    },
    stop: async () => new Blob(),
    cancel,
  };
  return {
    factory: async () => rec,
    cancel,
    goSilent(reason: string) {
      silentCb?.(reason);
    },
    feed(frame: () => Int16Array, ms: number) {
      for (let t = 0; t < ms; t += 40) pcmCb!(frame());
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('dictation mode', () => {
  it('shows a silent mic as an error instead of recording nothing', async () => {
    const r = fakeRecorder();
    const onError = vi.fn();
    const mode = startDictationMode(
      { recorderFactory: r.factory, transcribe: async () => ({ transcript: '' }) },
      { onText: () => {}, onBusy: () => {}, onError },
    );
    await mode.ready;
    r.goSilent('the microphone is only returning silence');
    expect(onError).toHaveBeenCalledWith(
      'voice: the microphone is only returning silence. Check the mic and try again.',
    );
    mode.stop();
  });

  it('opens a live preview per utterance, feeds it, and closes it when the utterance ends', async () => {
    const r = fakeRecorder();
    const partials: string[] = [];
    const stops: number[] = [];
    let pcb: { onPartial(t: string): void } | null = null;
    let pushed = 0;
    const openPreview = vi.fn((c) => {
      pcb = c;
      return { push: () => void pushed++, stop: () => void stops.push(1) };
    });
    const mode = startDictationMode(
      { recorderFactory: r.factory, transcribe: async () => ({ transcript: 'hi' }), openPreview },
      {
        onText: () => {},
        onBusy: () => {},
        onPartial: (t) => partials.push(t),
        onError: (m) => {
          throw new Error(m);
        },
      },
    );
    await mode.ready;
    r.feed(speech, 800);
    expect(openPreview).toHaveBeenCalledOnce();
    expect(pushed).toBeGreaterThan(0);
    pcb!.onPartial('hel');
    expect(partials).toEqual(['hel']);
    r.feed(quiet, 3200);
    await flush();
    expect(stops).toEqual([1]);
    expect(partials.at(-1)).toBe('');
    r.feed(speech, 800);
    expect(openPreview).toHaveBeenCalledTimes(2);
    mode.stop();
  });

  it('drops a stock phrase the speech model invented from a short noise burst', async () => {
    const r = fakeRecorder();
    const texts: string[] = [];
    const transcribe = vi.fn(async () => ({ transcript: ' Thank you. ' }));
    const mode = startDictationMode(
      { recorderFactory: r.factory, transcribe },
      {
        onText: (t) => texts.push(t),
        onBusy: () => {},
        onError: (m) => {
          throw new Error(m);
        },
      },
    );
    await mode.ready;
    r.feed(speech, 800);
    r.feed(quiet, 3200);
    await flush();
    expect(transcribe).toHaveBeenCalledOnce();
    expect(texts).toEqual([]);
    mode.stop();
  });

  it('sends each utterance as its own text and keeps listening', async () => {
    const r = fakeRecorder();
    const texts: string[] = [];
    const transcribe = vi.fn(async () => ({
      transcript: ` hello ${transcribe.mock.calls.length} `,
    }));
    const mode = startDictationMode(
      { recorderFactory: r.factory, transcribe },
      {
        onText: (t) => texts.push(t),
        onBusy: () => {},
        onError: (m) => {
          throw new Error(m);
        },
      },
    );
    await mode.ready;
    r.feed(speech, 800);
    r.feed(quiet, 3200);
    await flush();
    r.feed(speech, 800);
    r.feed(quiet, 3200);
    await flush();
    expect(texts).toEqual(['hello 1', 'hello 2']);
    expect(r.cancel).not.toHaveBeenCalled();
    mode.stop();
    expect(r.cancel).toHaveBeenCalledOnce();
  });

  it('uploads a wav of the utterance', async () => {
    const r = fakeRecorder();
    const transcribe = vi.fn(async (_c: Blob) => ({ transcript: 'x' }));
    const mode = startDictationMode(
      { recorderFactory: r.factory, transcribe },
      { onText: () => {}, onBusy: () => {}, onError: () => {} },
    );
    await mode.ready;
    r.feed(speech, 800);
    r.feed(quiet, 3200);
    await flush();
    expect(transcribe.mock.calls[0]![0].type).toBe('audio/wav');
  });

  it('does not send a silent transcript', async () => {
    const r = fakeRecorder();
    const onText = vi.fn();
    const mode = startDictationMode(
      { recorderFactory: r.factory, transcribe: async () => ({ transcript: '  ' }) },
      { onText, onBusy: () => {}, onError: () => {} },
    );
    await mode.ready;
    r.feed(speech, 800);
    r.feed(quiet, 3200);
    await flush();
    expect(onText).not.toHaveBeenCalled();
  });

  it('reports a transcription failure and keeps going', async () => {
    const r = fakeRecorder();
    const onError = vi.fn();
    const onText = vi.fn();
    let n = 0;
    const mode = startDictationMode(
      {
        recorderFactory: r.factory,
        transcribe: async () => {
          if (n++ === 0) throw new Error('boom');
          return { transcript: 'all good' };
        },
      },
      { onText, onBusy: () => {}, onError },
    );
    await mode.ready;
    for (let i = 0; i < 2; i++) {
      r.feed(speech, 800);
      r.feed(quiet, 3200);
      await flush();
    }
    expect(onError).toHaveBeenCalledWith('voice transcription failed: boom');
    expect(onText).toHaveBeenCalledWith('all good');
  });

  it('rejects ready when the mic cannot open', async () => {
    const mode = startDictationMode(
      {
        recorderFactory: async () => {
          throw new Error('denied');
        },
        transcribe: async () => ({ transcript: '' }),
      },
      { onText: () => {}, onBusy: () => {}, onError: () => {} },
    );
    await expect(mode.ready).rejects.toThrow('denied');
  });

  it('closes a mic that opened after stop()', async () => {
    const r = fakeRecorder();
    const mode = startDictationMode(
      { recorderFactory: r.factory, transcribe: async () => ({ transcript: '' }) },
      { onText: () => {}, onBusy: () => {}, onError: () => {} },
    );
    mode.stop();
    await mode.ready;
    expect(r.cancel).toHaveBeenCalled();
  });

  it('encodes a 16k mono wav', () => {
    expect(pcm16ToWavBlob(new Int16Array(100)).size).toBe(244);
  });

  describe('turn detection', () => {
    function withTurnCheck(answer: (n: number) => Promise<{ probability: number }>) {
      const r = fakeRecorder();
      const texts: string[] = [];
      const errors: string[] = [];
      const turnCheck = vi.fn(async (_c: Blob) => answer(turnCheck.mock.calls.length));
      const transcribe = vi.fn(async () => ({
        transcript: `said ${transcribe.mock.calls.length}`,
      }));
      const mode = startDictationMode(
        { recorderFactory: r.factory, transcribe, turnCheck, segmenter: { silenceMs: 10_000 } },
        { onText: (t) => texts.push(t), onBusy: () => {}, onError: (m) => errors.push(m) },
      );
      return { r, mode, texts, errors, turnCheck, transcribe };
    }

    it('sends at a short pause once the model says the turn is finished', async () => {
      const t = withTurnCheck(async () => ({ probability: 0.9 }));
      await t.mode.ready;
      t.r.feed(speech, 800);
      t.r.feed(quiet, 760);
      await flush();
      await flush();
      expect(t.turnCheck).toHaveBeenCalledOnce();
      expect(t.turnCheck.mock.calls[0]![0].type).toBe('audio/wav');
      expect(t.texts).toEqual(['said 1']);
    });

    it('keeps listening through a pause the model calls unfinished, and sends the whole thing later', async () => {
      const t = withTurnCheck(async (n) => ({ probability: n === 1 ? 0.1 : 0.95 }));
      await t.mode.ready;
      t.r.feed(speech, 800);
      t.r.feed(quiet, 1500);
      await flush();
      expect(t.texts).toEqual([]);
      t.r.feed(speech, 800);
      t.r.feed(quiet, 760);
      await flush();
      await flush();
      expect(t.turnCheck).toHaveBeenCalledTimes(2);
      expect(t.transcribe).toHaveBeenCalledOnce();
      expect(t.texts).toEqual(['said 1']);
    });

    it('a finished verdict that lands after speech resumed does not cut the sentence', async () => {
      let release: (v: { probability: number }) => void = () => {};
      const t = withTurnCheck((n) =>
        n === 1
          ? new Promise((r) => {
              release = r;
            })
          : Promise.resolve({ probability: 0.2 }),
      );
      await t.mode.ready;
      t.r.feed(speech, 800);
      t.r.feed(quiet, 760);
      t.r.feed(speech, 400);
      release({ probability: 0.99 });
      await flush();
      expect(t.transcribe).not.toHaveBeenCalled();
    });

    it('a failed check is shown, and the long silence still sends', async () => {
      const t = withTurnCheck(async () => {
        throw new Error('the host did not answer the turn check');
      });
      await t.mode.ready;
      t.r.feed(speech, 800);
      t.r.feed(quiet, 760);
      await flush();
      expect(t.errors).toEqual(['voice turn check failed: the host did not answer the turn check']);
      t.r.feed(quiet, 10_000);
      await flush();
      expect(t.texts).toEqual(['said 1']);
    });
  });
});
