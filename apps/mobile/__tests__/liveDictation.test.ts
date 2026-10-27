// lib/dictation.ts — the two live engines (spec/07 § Dictation engines).
//   stream: Deepgram on the host; the live words are the transcript, and a
//           finish asks the host for them instead of uploading the clip.
//   phone:  the phone's own recogniser; with tidy-up on, each finished segment
//           is uploaded for Whisper and swapped in as dictation goes on.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import { encodeAudio } from '@patch/wire/audio';
import type { PhoneSpeechEvent } from '../src/lib/phoneSpeech';

const meMock = vi.fn();
const voiceTokenMock = vi.fn();
const voiceTranscribeMock = vi.fn();
vi.mock('../src/api/rest', () => ({
  api: { me: meMock, voiceToken: voiceTokenMock, voiceTranscribe: voiceTranscribeMock },
}));

let micOnFrame: ((pcm: Int16Array) => void) | undefined;
const startMicCaptureMock = vi.fn(async (onFrame: (pcm: Int16Array) => void) => {
  micOnFrame = onFrame;
});
const stopMicCaptureMock = vi.fn(async () => undefined);
vi.mock('../src/lib/voiceMic', () => ({
  startMicCapture: startMicCaptureMock,
  stopMicCapture: stopMicCaptureMock,
}));

let speechOnEvent: ((ev: PhoneSpeechEvent) => void) | undefined;
const speechStop = vi.fn(async () => undefined);
const speechCancel = vi.fn(async () => undefined);
const startPhoneSpeechMock = vi.fn(async (onEvent: (ev: PhoneSpeechEvent) => void) => {
  speechOnEvent = onEvent;
  return { stop: speechStop, cancel: speechCancel };
});
vi.mock('../src/lib/phoneSpeech', () => ({ startPhoneSpeech: startPhoneSpeechMock }));

async function flush(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
function speak(ms: number): void {
  for (let i = 0; i < Math.ceil(ms / 40); i++) micOnFrame!(new Int16Array(640));
}
const sentJson = (ws: FakeWebSocket): Array<{ type: string }> =>
  ws.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d));

beforeEach(async () => {
  installFakeWebSocket();
  vi.clearAllMocks();
  (await import('../src/lib/dictation')).__resetDictationAudio();
  micOnFrame = undefined;
  speechOnEvent = undefined;
  meMock.mockResolvedValue({
    account: { accountId: 'acc1' },
    surface: { surfaceId: 'surf1' },
  });
  voiceTokenMock.mockResolvedValue({
    token: 'tok1',
    sessionId: 'sess-1',
    audioUrl: '/audio/sess-1',
    expiresAt: 0,
  });
  voiceTranscribeMock.mockResolvedValue({ ok: true, transcript: 'tidied' });
  startMicCaptureMock.mockImplementation(async (onFrame) => {
    micOnFrame = onFrame;
  });
  startPhoneSpeechMock.mockImplementation(async (onEvent) => {
    speechOnEvent = onEvent;
    return { stop: speechStop, cancel: speechCancel };
  });
});

afterEach(() => restoreWebSocket());

describe('stream engine (Deepgram)', () => {
  async function start(): Promise<{
    handle: import('../src/lib/dictation').DictationHandle;
    onPartial: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    onPreviewError: ReturnType<typeof vi.fn>;
    ws: FakeWebSocket;
  }> {
    const { startDictation } = await import('../src/lib/dictation');
    const onPartial = vi.fn();
    const onError = vi.fn();
    const onPreviewError = vi.fn();
    const handle = startDictation('c1', onPartial, onError, onPreviewError, { engine: 'stream' });
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    return { handle, onPartial, onError, onPreviewError, ws };
  }

  it('shows the live words and finishes with the host final — the clip is never uploaded', async () => {
    const { handle, onPartial, onError, ws } = await start();
    speak(200); // before the socket opens: held, then flushed
    ws.emitOpen();
    expect(sentJson(ws).map((m) => m.type)).toEqual(
      expect.arrayContaining(['audio.session_start', 'audio.pcm16']),
    );
    ws.emitMessage(
      encodeAudio({ type: 'audio.transcript_partial', sessionId: 'sess-1', text: 'buy oat' }),
    );
    expect(onPartial).toHaveBeenLastCalledWith('buy oat');

    const done = handle.finish(true);
    await flush();
    expect(sentJson(ws).some((m) => m.type === 'audio.dictation_finish')).toBe(true);
    ws.emitMessage(
      encodeAudio({ type: 'audio.transcript_final', sessionId: 'sess-1', text: 'buy oat milk' }),
    );
    expect(await done).toEqual({ kind: 'text', text: 'buy oat milk' });
    expect(voiceTranscribeMock).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(sentJson(ws).at(-1)).toMatchObject({ type: 'audio.session_end', reason: 'cancelled' });
  });

  it('a finish before the socket opened is sent as soon as it does', async () => {
    const { handle, ws } = await start();
    speak(200);
    const done = handle.finish(true);
    await flush();
    ws.emitOpen();
    const types = sentJson(ws).map((m) => m.type);
    expect(types.indexOf('audio.dictation_finish')).toBeGreaterThan(types.indexOf('audio.pcm16'));
    ws.emitMessage(
      encodeAudio({ type: 'audio.transcript_final', sessionId: 'sess-1', text: 'quick' }),
    );
    expect(await done).toEqual({ kind: 'text', text: 'quick' });
  });

  it('Deepgram failing is the dictation failing, said through onError', async () => {
    const { onError, ws } = await start();
    ws.emitOpen();
    ws.emitMessage(
      encodeAudio({
        type: 'audio.error',
        code: 'deepgram_unavailable',
        message: 'Live dictation failed: HTTP 401',
        sessionId: 'sess-1',
      }),
    );
    await flush();
    expect(onError).toHaveBeenCalledWith('Live dictation failed: HTTP 401');
    expect(stopMicCaptureMock).toHaveBeenCalled();
  });

  it('a failed tidy-up is only a warning: the dictation carries on', async () => {
    const { onError, onPreviewError, ws } = await start();
    ws.emitOpen();
    ws.emitMessage(
      encodeAudio({
        type: 'audio.error',
        code: 'whisper_unavailable',
        message: 'Tidying up with Whisper failed',
        sessionId: 'sess-1',
      }),
    );
    expect(onPreviewError).toHaveBeenCalledWith('Tidying up with Whisper failed');
    expect(onError).not.toHaveBeenCalled();
  });

  it('nothing captured reports no-audio rather than an empty success', async () => {
    const { handle, ws } = await start();
    ws.emitOpen();
    expect(await handle.finish(true)).toEqual({ kind: 'no-audio' });
  });
});

describe('phone engine', () => {
  async function start(tidy: boolean): Promise<{
    handle: import('../src/lib/dictation').DictationHandle;
    onPartial: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    onPreviewError: ReturnType<typeof vi.fn>;
  }> {
    const { startDictation } = await import('../src/lib/dictation');
    const onPartial = vi.fn();
    const onError = vi.fn();
    const onPreviewError = vi.fn();
    const handle = startDictation('c1', onPartial, onError, onPreviewError, {
      engine: 'phone',
      tidy,
    });
    await flush();
    return { handle, onPartial, onError, onPreviewError };
  }

  it('the recogniser starts before the mic, and nothing goes to the network without tidy-up', async () => {
    const { handle, onPartial } = await start(false);
    expect(startPhoneSpeechMock.mock.invocationCallOrder[0]).toBeLessThan(
      startMicCaptureMock.mock.invocationCallOrder[0]!,
    );
    speak(400);
    speechOnEvent!({ type: 'partial', text: 'buy oat' });
    expect(onPartial).toHaveBeenLastCalledWith('buy oat');
    speechOnEvent!({ type: 'segment', text: 'buy oat milk' });
    speechOnEvent!({ type: 'partial', text: 'and bread' });
    expect(onPartial).toHaveBeenLastCalledWith('buy oat milk and bread');

    speechStop.mockImplementationOnce(async () => {
      speechOnEvent!({ type: 'segment', text: 'and bread' });
      speechOnEvent!({ type: 'end' });
    });
    expect(await handle.finish(true)).toEqual({ kind: 'text', text: 'buy oat milk and bread' });
    expect(voiceTranscribeMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('tidy-up swaps each finished segment for Whisper’s version as it goes, asking for Whisper by name', async () => {
    voiceTranscribeMock.mockResolvedValueOnce({ ok: true, transcript: 'Buy oat milk.' });
    const { handle, onPartial } = await start(true);
    speak(800);
    speechOnEvent!({ type: 'segment', text: 'by oat milk' });
    speak(400);
    speechOnEvent!({ type: 'partial', text: 'and' });
    await flush(60);
    expect(voiceTranscribeMock).toHaveBeenCalledWith(expect.any(String), { engine: 'whisper' });
    expect(onPartial).toHaveBeenLastCalledWith('Buy oat milk. and');

    voiceTranscribeMock.mockResolvedValueOnce({ ok: true, transcript: 'And bread.' });
    speechStop.mockImplementationOnce(async () => {
      speechOnEvent!({ type: 'segment', text: 'and bred' });
      speechOnEvent!({ type: 'end' });
    });
    expect(await handle.finish(true)).toEqual({ kind: 'text', text: 'Buy oat milk. And bread.' });
  });

  it('a failed tidy-up is reported once and the phone’s words stand', async () => {
    voiceTranscribeMock.mockRejectedValue(new Error('HTTP 502'));
    const { handle, onPreviewError, onError } = await start(true);
    speak(400);
    speechOnEvent!({ type: 'segment', text: 'first' });
    speak(400);
    speechOnEvent!({ type: 'segment', text: 'second' });
    speechStop.mockImplementationOnce(async () => speechOnEvent!({ type: 'end' }));
    expect(await handle.finish(true)).toEqual({ kind: 'text', text: 'first second' });
    expect(onPreviewError).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a recogniser error fails the dictation loudly', async () => {
    const { onError } = await start(false);
    speechOnEvent!({ type: 'error', message: 'language not downloaded' });
    await flush();
    expect(onError).toHaveBeenCalledWith("the phone's recogniser failed: language not downloaded");
    expect(speechCancel).toHaveBeenCalled();
  });

  it('a recogniser that cannot start (older Android) fails before the mic opens', async () => {
    startPhoneSpeechMock.mockRejectedValueOnce(
      new Error("The phone's own recogniser needs Android 13 or newer"),
    );
    const { onError } = await start(false);
    expect(onError).toHaveBeenCalledWith(
      "dictation setup failed: The phone's own recogniser needs Android 13 or newer",
    );
    expect(startMicCaptureMock).not.toHaveBeenCalled();
  });

  it('Clear cancels the recogniser and lands nothing', async () => {
    const { handle } = await start(false);
    speak(400);
    expect(await handle.finish(false)).toEqual({ kind: 'discarded' });
    expect(speechCancel).toHaveBeenCalled();
  });
});

describe('which engine the composer uses', () => {
  it('follows the phone setting: Built-in, Deepgram streaming, or Whisper with nothing to tidy', async () => {
    const { dictationEngineFor } = await import('../src/lib/dictationEngine');
    const cfg = (phone: 'device' | 'deepgram' | 'whisper') =>
      ({ phone, computer: 'deepgram', tidy: true }) as const;
    expect(dictationEngineFor(cfg('device'))).toEqual({ engine: 'phone', tidy: true });
    expect(dictationEngineFor(cfg('deepgram'))).toEqual({ engine: 'stream', tidy: true });
    expect(dictationEngineFor(cfg('whisper'))).toEqual({ engine: 'whisper', tidy: false });
  });
});
