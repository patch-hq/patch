// lib/dictationMode.ts — the always-open phone dictation (spec/07 § Dictation mode).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const voiceTranscribeMock = vi.fn(async (_uri: string) => ({
  ok: true as const,
  transcript: ' hi ',
}));
const voiceTurnCheckMock = vi.fn(async (_uri: string) => ({ ok: true as const, probability: 0.9 }));
vi.mock('../src/api/rest', () => ({
  api: { voiceTranscribe: voiceTranscribeMock, voiceTurnCheck: voiceTurnCheckMock },
}));

let onFrame: ((pcm: Int16Array) => void) | undefined;
let onMicError: ((m: string) => void) | undefined;
const startMicCaptureMock = vi.fn(async (f: (pcm: Int16Array) => void, e: (m: string) => void) => {
  onFrame = f;
  onMicError = e;
});
const stopMicCaptureMock = vi.fn(async () => undefined);
vi.mock('../src/lib/voiceMic', () => ({
  startMicCapture: startMicCaptureMock,
  stopMicCapture: stopMicCaptureMock,
}));

const speech = (): Int16Array => new Int16Array(640).fill(6000);
const quiet = (): Int16Array => new Int16Array(640);
function feed(frame: () => Int16Array, ms: number): void {
  for (let t = 0; t < ms; t += 40) onFrame!(frame());
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  onFrame = undefined;
  onMicError = undefined;
  voiceTranscribeMock.mockResolvedValue({ ok: true, transcript: ' hi ' });
  voiceTurnCheckMock.mockResolvedValue({ ok: true, probability: 0.9 });
});

async function start(options?: import('../src/lib/dictationMode').DictationModeOptions) {
  const { startDictationMode } = await import('../src/lib/dictationMode');
  const texts: string[] = [];
  const errors: string[] = [];
  const busy: number[] = [];
  const h = startDictationMode(
    {
      onText: (t) => texts.push(t),
      onError: (m) => errors.push(m),
      onBusy: (n) => busy.push(n),
    },
    options,
  );
  await flush();
  return { h, texts, errors, busy };
}

describe('mobile dictation mode', () => {
  it('opens the mic once and sends each utterance separately', async () => {
    const { texts, errors } = await start();
    expect(startMicCaptureMock).toHaveBeenCalledOnce();
    feed(speech, 800);
    feed(quiet, 3200);
    await flush();
    feed(speech, 800);
    feed(quiet, 3200);
    await flush();
    expect(texts).toEqual(['hi', 'hi']);
    expect(errors).toEqual([]);
    expect(voiceTranscribeMock).toHaveBeenCalledTimes(2);
    expect(stopMicCaptureMock).not.toHaveBeenCalled();
  });

  it('does not upload while the speaker is only pausing', async () => {
    const { texts } = await start();
    feed(speech, 800);
    feed(quiet, 2000);
    await flush();
    expect(voiceTranscribeMock).not.toHaveBeenCalled();
    expect(texts).toEqual([]);
  });

  it('does not send an empty transcript', async () => {
    voiceTranscribeMock.mockResolvedValue({ ok: true, transcript: '  ' });
    const { texts } = await start();
    feed(speech, 800);
    feed(quiet, 3200);
    await flush();
    expect(texts).toEqual([]);
  });

  it('reports a failed transcription and keeps listening', async () => {
    voiceTranscribeMock.mockRejectedValueOnce(new Error('boom'));
    const { texts, errors } = await start();
    feed(speech, 800);
    feed(quiet, 3200);
    await flush();
    feed(speech, 800);
    feed(quiet, 3200);
    await flush();
    expect(errors).toEqual(['voice transcription failed: boom']);
    expect(texts).toEqual(['hi']);
  });

  it('surfaces a mic that fails to start and a native read failure', async () => {
    startMicCaptureMock.mockRejectedValueOnce(new Error('permission denied'));
    const a = await start();
    expect(a.errors).toEqual(['dictation setup failed: permission denied']);
    const b = await start();
    onMicError!('read loop died');
    expect(b.errors).toEqual(['dictation mic failed: read loop died']);
  });

  it('stop() releases the mic, and ignores audio afterwards', async () => {
    const { h, texts } = await start();
    feed(speech, 800);
    await h.stop();
    expect(stopMicCaptureMock).toHaveBeenCalledOnce();
    feed(quiet, 3200);
    await flush();
    expect(texts).toEqual([]);
    await h.stop();
    expect(stopMicCaptureMock).toHaveBeenCalledOnce();
  });

  describe('turn detection', () => {
    const detecting = { turnDetection: true, segmenter: { silenceMs: 10_000 } };

    it('sends at a short pause once the host says the turn is finished', async () => {
      const { texts } = await start(detecting);
      feed(speech, 800);
      feed(quiet, 760);
      await flush();
      expect(voiceTurnCheckMock).toHaveBeenCalledOnce();
      expect(voiceTurnCheckMock.mock.calls[0]![0]).toMatch(/turn-check-.*\.wav$/);
      expect(texts).toEqual(['hi']);
    });

    it('keeps listening through a pause called unfinished', async () => {
      voiceTurnCheckMock.mockResolvedValueOnce({ ok: true, probability: 0.1 });
      const { texts } = await start(detecting);
      feed(speech, 800);
      feed(quiet, 2000);
      await flush();
      expect(texts).toEqual([]);
      feed(speech, 800);
      feed(quiet, 760);
      await flush();
      expect(voiceTranscribeMock).toHaveBeenCalledOnce();
      expect(texts).toEqual(['hi']);
    });

    it('shows a failed check and still sends at the long silence', async () => {
      voiceTurnCheckMock.mockRejectedValueOnce(
        new Error('daemon_timeout: the host may need updating'),
      );
      const { texts, errors } = await start(detecting);
      feed(speech, 800);
      feed(quiet, 760);
      await flush();
      expect(errors).toEqual([
        'voice turn check failed: daemon_timeout: the host may need updating',
      ]);
      feed(quiet, 10_000);
      await flush();
      expect(texts).toEqual(['hi']);
    });

    it('never asks when turn detection is off', async () => {
      await start({ segmenter: { silenceMs: 3000 } });
      feed(speech, 800);
      feed(quiet, 3200);
      await flush();
      expect(voiceTurnCheckMock).not.toHaveBeenCalled();
    });
  });
});
