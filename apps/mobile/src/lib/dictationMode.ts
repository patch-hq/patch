// Dictation mode on the phone (spec/07 § Dictation mode): long-press the
// composer mic and it stays open. The native mic tap keeps running; each time
// the speaker goes quiet for a few seconds the speech so far is cut out as one
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

export function startDictationMode(
  cb: DictationModeCallbacks,
  segmenterOptions?: UtteranceSegmenterOptions,
): DictationModeHandle {
  const segmenter = createUtteranceSegmenter({ sampleRate: SAMPLE_RATE, ...segmenterOptions });
  let stopped = false;
  let micStarted = false;
  let pending = 0;
  let chain: Promise<void> = Promise.resolve();

  async function transcribe(pcm: Int16Array): Promise<string> {
    const dir = FileSystem.cacheDirectory;
    if (!dir) throw new Error('no cache directory available');
    const uri = `${dir}dictation-mode-${Date.now()}.wav`;
    await FileSystem.writeAsStringAsync(uri, encodeBase64(encodePcm16Wav(pcm, SAMPLE_RATE)), {
      encoding: FileSystem.EncodingType.Base64,
    });
    const { transcript } = await api.voiceTranscribe(uri);
    return transcript.trim();
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
