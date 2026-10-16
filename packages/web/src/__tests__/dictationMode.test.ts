import { describe, expect, it, vi } from 'vitest';
import { startDictationMode, pcm16ToWavBlob } from '../lib/dictationMode.js';
import type { VoiceRecording } from '../lib/voiceRecorder.js';

const FRAME = 640;
const speech = (): Int16Array => new Int16Array(FRAME).fill(6000);
const quiet = (): Int16Array => new Int16Array(FRAME);

function fakeRecorder() {
  let pcmCb: ((p: Int16Array) => void) | null = null;
  const cancel = vi.fn();
  const rec: VoiceRecording = {
    onLevel: () => {},
    onPcm: (cb) => {
      pcmCb = cb;
    },
    stop: async () => new Blob(),
    cancel,
  };
  return {
    factory: async () => rec,
    cancel,
    feed(frame: () => Int16Array, ms: number) {
      for (let t = 0; t < ms; t += 40) pcmCb!(frame());
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('dictation mode', () => {
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
          return { transcript: 'ok' };
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
    expect(onText).toHaveBeenCalledWith('ok');
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
});
