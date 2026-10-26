// Dictation mode (spec/07 § Dictation mode): the composer's mic left open.
// The user keeps talking; each time they finish — Smart Turn, asked at every
// short pause, says so, or a long silence does — what they said is transcribed
// and handed to `onText` (the composer sends it), then the mic carries on
// listening for the next thing. It is not a call — no agent
// speaks back — it is dictation that does not need a button press per message.
//
// One microphone capture for the whole session (`startRecording`), tapped via
// its PCM feed and cut into utterances by the shared segmenter. Utterances are
// transcribed strictly in order so two quick messages cannot arrive swapped.
// Every failure goes to `onError`; nothing is swallowed.

import {
  createUtteranceSegmenter,
  type UtteranceSegmenterOptions,
} from '@patch/wire/utterance-segmenter';
import { startRecording, type VoiceRecording } from './voiceRecorder.js';
import type { DictationPreview, DictationPreviewCallbacks } from './dictationPreview.js';

const SAMPLE_RATE = 16000;

export interface DictationModeDeps {
  recorderFactory?: () => Promise<VoiceRecording>;
  transcribe: (clip: Blob) => Promise<{ transcript: string }>;
  /**
   * Has the speaker finished? Asked at each short pause; without it only the
   * segmenter's long silence ends an utterance.
   */
  turnCheck?: (clip: Blob) => Promise<{ probability: number }>;
  segmenter?: UtteranceSegmenterOptions;
  /**
   * Opens a live-transcript session for one utterance (spec/07 § Dictation
   * mode). Called when speech starts; stopped when the utterance is cut or
   * dropped. Without it there is no interim text.
   */
  openPreview?: (callbacks: DictationPreviewCallbacks) => DictationPreview;
}

/** Quiet this long after speech asks the turn check. */
export const TURN_CHECK_PAUSE_MS = 700;
/** Smart Turn's own decision threshold. */
export const TURN_COMPLETE = 0.5;

export interface DictationModeCallbacks {
  /** A finished utterance's text, non-empty and trimmed. */
  onText(text: string): void;
  /** Capture is running (true) / the user has gone quiet and a transcript is pending (busy). */
  onBusy(pending: number): void;
  /** Interim words of the utterance being spoken; '' once it ends. */
  onPartial?(text: string): void;
  onError(message: string): void;
}

export interface DictationMode {
  /** Resolves once the microphone is open; rejects if it could not be. */
  ready: Promise<void>;
  /** Close the mic. Speech not yet cut into an utterance is dropped. */
  stop(): void;
}

export function pcm16ToWavBlob(pcm: Int16Array, sampleRate = SAMPLE_RATE): Blob {
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buffer);
  const ascii = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, dataSize, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

export function startDictationMode(
  deps: DictationModeDeps,
  cb: DictationModeCallbacks,
): DictationMode {
  const turnCheck = deps.turnCheck;
  const segmenter = createUtteranceSegmenter({
    sampleRate: SAMPLE_RATE,
    ...deps.segmenter,
    ...(turnCheck
      ? {
          pauseMs: TURN_CHECK_PAUSE_MS,
          onPause: (pcm: Int16Array, seq: number): void => {
            turnCheck(pcm16ToWavBlob(pcm)).then(
              ({ probability }) => {
                if (stopped || probability < TURN_COMPLETE) return;
                const utterance = segmenter.cut(seq);
                if (utterance) {
                  closePreview();
                  enqueue(utterance);
                }
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
  let rec: VoiceRecording | null = null;
  let pending = 0;
  let chain: Promise<void> = Promise.resolve();
  let preview: DictationPreview | null = null;

  function closePreview(): void {
    if (!preview) return;
    preview.stop();
    preview = null;
    cb.onPartial?.('');
  }

  function enqueue(pcm: Int16Array): void {
    pending++;
    cb.onBusy(pending);
    chain = chain.then(async () => {
      try {
        const { transcript } = await deps.transcribe(pcm16ToWavBlob(pcm));
        const text = transcript.trim();
        if (!stopped && text) cb.onText(text);
      } catch (e) {
        if (!stopped) cb.onError(`voice transcription failed: ${(e as Error).message}`);
      } finally {
        pending--;
        if (!stopped) cb.onBusy(pending);
      }
    });
  }

  const ready = (async (): Promise<void> => {
    const r = await (deps.recorderFactory ?? startRecording)();
    if (stopped) {
      r.cancel();
      return;
    }
    rec = r;
    r.onPcm((pcm) => {
      if (stopped) return;
      const utterance = segmenter.push(pcm);
      if (deps.openPreview) {
        if (!preview && segmenter.speaking) {
          preview = deps.openPreview({
            onPartial: (text) => {
              if (!stopped && preview) cb.onPartial?.(text);
            },
            onPreviewError: (m) =>
              cb.onError(`voice: live transcript unavailable (still recording): ${m}`),
          });
        }
        preview?.push(pcm);
      }
      if (utterance) {
        closePreview();
        enqueue(utterance);
      } else if (preview && !segmenter.speaking) closePreview();
    });
  })();

  return {
    ready,
    stop(): void {
      if (stopped) return;
      stopped = true;
      closePreview();
      rec?.cancel();
      rec = null;
    },
  };
}
