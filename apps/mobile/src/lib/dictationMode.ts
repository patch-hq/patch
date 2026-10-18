// Dictation mode on the phone (spec/07 § Dictation mode): long-press the
// composer mic → Keep dictating, and it stays open. The native mic tap keeps
// running; each time the speaker finishes — Smart Turn, asked at every short
// pause, says so, or a long silence does — the speech so far is cut out as one
// utterance, transcribed through the same `POST /api/voice/transcribe` the
// composer's tap-dictation uses, and handed to `onText` (the composer sends
// it). Not a call: nothing speaks back, and there is no live preview.
//
// Utterances are transcribed strictly in order. Every failure reaches `onError`.

import * as FileSystem from 'expo-file-system';
import {
  createUtteranceSegmenter,
  type UtteranceSegmenterOptions,
} from '@patch/wire/utterance-segmenter';
import { api } from '../api/rest';
import { startMicCapture, stopMicCapture } from './voiceMic';
import { encodePcm16Wav, encodeBase64 } from './pcmWav';

const SAMPLE_RATE = 16000;

export interface DictationModeCallbacks {
  /** A finished utterance's text, non-empty and trimmed. */
  onText(text: string): void;
  /** Utterances waiting on a transcript. */
  onBusy(pending: number): void;
  onError(message: string): void;
}

export interface DictationModeHandle {
  /** Close the mic. Speech not yet cut into an utterance is dropped. */
  stop(): Promise<void>;
}

/** Quiet this long after speech asks the turn check. */
export const TURN_CHECK_PAUSE_MS = 700;
/** Smart Turn's own decision threshold. */
export const TURN_COMPLETE = 0.5;

export interface DictationModeOptions {
  segmenter?: UtteranceSegmenterOptions;
  /** Ask Smart Turn at each short pause whether the speaker has finished. */
  turnDetection?: boolean;
}

export function startDictationMode(
  cb: DictationModeCallbacks,
  options: DictationModeOptions = {},
): DictationModeHandle {
  const segmenter = createUtteranceSegmenter({
    sampleRate: SAMPLE_RATE,
    ...options.segmenter,
    ...(options.turnDetection
      ? {
          pauseMs: TURN_CHECK_PAUSE_MS,
          onPause: (pcm: Int16Array, seq: number): void => {
            turnCheck(pcm).then(
              (probability) => {
                if (stopped || probability < TURN_COMPLETE) return;
                const utterance = segmenter.cut(seq);
                if (utterance) enqueue(utterance);
              },
              (e: Error) => {
                if (!stopped) cb.onError(`voice turn check failed: ${e.message}`);
              },
            );
          },
        }
      : {}),
  });
  let stopped = false;
  let micStarted = false;
  let pending = 0;
  let chain: Promise<void> = Promise.resolve();

  async function writeWav(pcm: Int16Array, name: string): Promise<string> {
    const dir = FileSystem.cacheDirectory;
    if (!dir) throw new Error('no cache directory available');
    const uri = `${dir}${name}-${Date.now()}.wav`;
    await FileSystem.writeAsStringAsync(uri, encodeBase64(encodePcm16Wav(pcm, SAMPLE_RATE)), {
      encoding: FileSystem.EncodingType.Base64,
    });
    return uri;
  }

  async function transcribe(pcm: Int16Array): Promise<string> {
    const uri = await writeWav(pcm, 'dictation-mode');
    const { transcript } = await api.voiceTranscribe(uri);
    return transcript.trim();
  }

  async function turnCheck(pcm: Int16Array): Promise<number> {
    const uri = await writeWav(pcm, 'turn-check');
    try {
      return (await api.voiceTurnCheck(uri)).probability;
    } finally {
      // A clip per pause would pile up in the cache; a failed delete is only
      // worth a log line, not a toast.
      void FileSystem.deleteAsync(uri, { idempotent: true }).catch((e: Error) =>
        console.warn(`[patch-voice] turn-check clip not deleted: ${e.message}`),
      );
    }
  }

  function enqueue(pcm: Int16Array): void {
    pending++;
    cb.onBusy(pending);
    chain = chain.then(async () => {
      try {
        const text = await transcribe(pcm);
        if (!stopped && text) cb.onText(text);
      } catch (e) {
        if (!stopped) cb.onError(`voice transcription failed: ${(e as Error).message}`);
      } finally {
        pending--;
        if (!stopped) cb.onBusy(pending);
      }
    });
  }

  void (async () => {
    try {
      await startMicCapture(
        (pcm) => {
          if (stopped) return;
          const utterance = segmenter.push(pcm);
          if (utterance) enqueue(utterance);
        },
        (message) => {
          if (!stopped) cb.onError(`dictation mic failed: ${message}`);
        },
      );
      micStarted = true;
      if (stopped) await stopMicCapture().catch(() => undefined);
    } catch (e) {
      if (!stopped) cb.onError(`dictation setup failed: ${(e as Error).message}`);
    }
  })();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (micStarted) await stopMicCapture().catch(() => undefined);
    },
  };
}
