// The direct call itself (spec/07 § Direct calls), the same on every surface.
//
// The surface feeds it the microphone and tells it what the chat agent is
// doing; it cuts the speech into utterances, asks Smart Turn at each short
// pause whether the speaker has finished, reads each finished utterance with
// the device's speech-to-text engine, sends the words as the user's turn
// strictly in the order spoken, and reads the agent's reply aloud piece by piece
// with the device's text-to-speech engine. Speech while a reply is being read
// stops the reading (barge-in).
//
// Every surface implements the same three engine interfaces — speech to text,
// text to speech, turn detection — whether the engine runs on the device or in
// the cloud through the chat's host; nothing here knows which.
//
// NO FALLBACK: an engine that fails is reported naming it, the call stays open,
// and nothing is answered by another engine.

import {
  createUtteranceSegmenter,
  isPhantomTranscript,
  speechMs,
  type UtteranceSegmenterOptions,
} from './utterance-segmenter.js';
import {
  speakablePieces,
  STT_ENGINE_LABEL,
  TTS_ENGINE_LABEL,
  type CloudSttEngine,
  type CloudTtsEngine,
  type DirectTtsSound,
} from './direct-call.js';
import { TURN_CHECK_PAUSE_MS, TURN_COMPLETE } from './smart-turn.js';

export const DIRECT_CALL_SAMPLE_RATE = 16000;

/** Reads one finished utterance (16 kHz mono PCM16). */
export interface DirectSpeechToText {
  /** How the engine is named on the call bar (`Parakeet`, `Groq Whisper`). */
  readonly label: string;
  transcribe(pcm: Int16Array): Promise<string>;
}

/** One piece of a reply, made and ready to play. */
export interface PreparedSpeech {
  /** Plays it; resolves when it has finished or been stopped. */
  play(): Promise<void>;
  /** Stops it now (barge-in, hang-up). Idempotent. */
  stop(): void;
}

/** Speaks text on the device. */
export interface DirectTextToSpeech {
  readonly label: string;
  /** Make one piece; the next piece is made while this one plays. */
  prepare(text: string): Promise<PreparedSpeech>;
}

/** Smart Turn run on the device: the probability the speaker has finished. */
export interface DirectTurnDetector {
  readonly label: string;
  probability(pcm: Int16Array): Promise<number>;
}

export interface DirectCallEngines {
  stt: DirectSpeechToText;
  tts: DirectTextToSpeech;
  turn: DirectTurnDetector;
}

export interface DirectCallOptions {
  /** Send the words as the user's turn, tagged voice; mid-turn it queues. */
  sendTurn(text: string): Promise<void>;
  /** Quiet this long ends an utterance whatever Smart Turn says (`dictationPauseSeconds`). */
  longPauseMs: number;
  /** Ask Smart Turn at each short pause (`dictationTurnDetection`); off: the long pause alone decides. */
  detectTurns: boolean;
  segmenter?: Omit<UtteranceSegmenterOptions, 'sampleRate' | 'silenceMs' | 'pauseMs' | 'onPause'>;
  /** Clock for the agent-working timer (tests). */
  now?: () => number;
}

/** What the line is doing now, for the call bar. */
export interface DirectCallStatus {
  line: 'listening' | 'hearing' | 'sending' | 'working' | 'speaking';
  /** When the chat agent started working, while it is. */
  workingSince: number | null;
  /** The last engine failure, naming the engine; cleared by that engine's next success. */
  failure: string | null;
  /** Interim: utterances read or being sent, not yet delivered. */
  pending: number;
}

export interface DirectCall {
  /** Feed the microphone (16 kHz mono PCM16). Ignored while muted. */
  pushPcm(pcm: Int16Array): void;
  /** The chat agent's turn state, from the surface's own view of the chat. */
  setAgentWorking(working: boolean, since?: number): void;
  /** A reply that ended the agent's turn: read it aloud. */
  agentReplied(text: string): void;
  setMuted(muted: boolean): void;
  status(): DirectCallStatus;
  /** Stop listening and reading; nothing more is sent. */
  end(): void;
}

export function startDirectCall(
  engines: DirectCallEngines,
  opts: DirectCallOptions,
  onStatus: (s: DirectCallStatus) => void,
): DirectCall {
  const now = opts.now ?? Date.now;
  let ended = false;
  let muted = false;
  let pending = 0;
  let workingSince: number | null = null;
  let failure: { engine: string; message: string } | null = null;
  let speaking = false;
  let sendChain: Promise<void> = Promise.resolve();

  const segmenter = createUtteranceSegmenter({
    ...opts.segmenter,
    sampleRate: DIRECT_CALL_SAMPLE_RATE,
    silenceMs: opts.longPauseMs,
    ...(opts.detectTurns
      ? {
          pauseMs: TURN_CHECK_PAUSE_MS,
          onPause: (pcm: Int16Array, seq: number): void => {
            engines.turn.probability(pcm).then(
              (p) => {
                succeeded(engines.turn.label);
                if (ended || p < TURN_COMPLETE) return;
                const utterance = segmenter.cut(seq);
                if (utterance) deliver(utterance);
              },
              (e: Error) => fail(engines.turn.label, e),
            );
          },
        }
      : {}),
  });

  function status(): DirectCallStatus {
    const line: DirectCallStatus['line'] = speaking
      ? 'speaking'
      : segmenter.speaking
        ? 'hearing'
        : pending > 0
          ? 'sending'
          : workingSince !== null
            ? 'working'
            : 'listening';
    return {
      line,
      workingSince,
      failure: failure ? `${failure.engine} failed — ${failure.message}` : null,
      pending,
    };
  }
  let last = '';
  function emit(): void {
    if (ended) return;
    const s = status();
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    onStatus(s);
  }
  function fail(engine: string, e: Error): void {
    if (ended) return;
    failure = { engine, message: e.message };
    emit();
  }
  function succeeded(engine: string): void {
    if (failure?.engine === engine) {
      failure = null;
      emit();
    }
  }

  // ---- speech in: utterance → words → the user's turn, strictly in order ----
  function deliver(pcm: Int16Array): void {
    pending++;
    emit();
    const read = engines.stt.transcribe(pcm).then(
      (t) => {
        succeeded(engines.stt.label);
        return t.trim();
      },
      (e: Error) => {
        fail(engines.stt.label, e);
        return '';
      },
    );
    sendChain = sendChain.then(async () => {
      try {
        const text = await read;
        if (ended || !text) return;
        if (isPhantomTranscript(text, speechMs(pcm, DIRECT_CALL_SAMPLE_RATE))) return;
        await opts.sendTurn(text);
        succeeded('Sending');
      } catch (e) {
        fail('Sending', e as Error);
      } finally {
        pending--;
        emit();
      }
    });
  }

  // ---- speech out: each reply read piece by piece; barge-in drops the rest ----
  let generation = 0;
  let current: PreparedSpeech | null = null;
  let readChain: Promise<void> = Promise.resolve();

  function stopReading(): void {
    generation++;
    current?.stop();
    current = null;
    if (speaking) {
      speaking = false;
      emit();
    }
  }

  function read(text: string): void {
    const pieces = speakablePieces(text);
    if (pieces.length === 0) return;
    const gen = generation;
    readChain = readChain.then(async () => {
      if (ended || gen !== generation) return;
      let next: Promise<PreparedSpeech> | null = engines.tts.prepare(pieces[0]!);
      for (let i = 0; i < pieces.length && next; i++) {
        let piece: PreparedSpeech;
        try {
          piece = await next;
          succeeded(engines.tts.label);
        } catch (e) {
          fail(engines.tts.label, e as Error);
          break;
        }
        if (ended || gen !== generation) {
          piece.stop();
          return;
        }
        next = i + 1 < pieces.length ? engines.tts.prepare(pieces[i + 1]!) : null;
        // A prepare that fails while this piece plays is reported when it is reached.
        next?.catch(() => undefined);
        current = piece;
        speaking = true;
        emit();
        try {
          await piece.play();
        } catch (e) {
          fail(engines.tts.label, e as Error);
          break;
        }
        if (current === piece) current = null;
        if (gen !== generation) return;
      }
      if (gen === generation && speaking) {
        speaking = false;
        emit();
      }
    });
  }

  return {
    pushPcm(pcm) {
      if (ended || muted) return;
      const wasSpeaking = segmenter.speaking;
      const utterance = segmenter.push(pcm);
      if (!wasSpeaking && segmenter.speaking && speaking) stopReading();
      if (utterance) deliver(utterance);
      if (wasSpeaking !== segmenter.speaking) emit();
    },
    setAgentWorking(working, since) {
      const next = working ? (workingSince ?? since ?? now()) : null;
      if (next === workingSince) return;
      workingSince = next;
      emit();
    },
    agentReplied(text) {
      if (ended) return;
      read(text);
    },
    setMuted(m) {
      muted = m;
      if (m) segmenter.flush();
      emit();
    },
    status,
    end() {
      if (ended) return;
      stopReading();
      ended = true;
    },
  };
}

// ---- Cloud engines, reached through the chat's host (the same on every surface) ----

/** The surface's authenticated JSON POST; rejects with the server's message on a non-2xx. */
export type DirectCallPost = <T>(path: string, body: object) => Promise<T>;

/** 16 kHz mono PCM16 as a WAV file. */
export function pcm16ToWav(pcm: Int16Array, sampleRate = DIRECT_CALL_SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
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
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i]!, true);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without Buffer or btoa, so it runs the same in a browser, Node and React Native. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${B64[n >> 18]!}${B64[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64[n >> 18]!}${B64[(n >> 12) & 63]!}${B64[(n >> 6) & 63]!}=`;
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]!) << 18) |
      (B64.indexOf(clean[i + 1] ?? 'A') << 12) |
      ((i + 2 < clean.length ? B64.indexOf(clean[i + 2]!) : 0) << 6) |
      (i + 3 < clean.length ? B64.indexOf(clean[i + 3]!) : 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Little-endian PCM16 bytes as samples. */
export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = v.getInt16(i * 2, true);
  return out;
}

export function cloudSpeechToText(args: {
  post: DirectCallPost;
  chatId: string;
  engine: CloudSttEngine;
  model: string;
}): DirectSpeechToText {
  return {
    label: STT_ENGINE_LABEL[args.engine],
    async transcribe(pcm) {
      const r = await args.post<{ transcript: string }>('/api/voice/direct/transcribe', {
        chatId: args.chatId,
        engine: args.engine,
        model: args.model,
        audioBase64: bytesToBase64(pcm16ToWav(pcm)),
      });
      return r.transcript;
    },
  };
}

export function cloudTextToSpeech(args: {
  post: DirectCallPost;
  chatId: string;
  engine: CloudTtsEngine;
  model: string;
  voice: string;
  sound: DirectTtsSound;
  /** The surface's own player for 24 kHz PCM16. */
  play: (pcm: Int16Array, sampleRate: number) => PreparedSpeech;
}): DirectTextToSpeech {
  return {
    label: TTS_ENGINE_LABEL[args.engine],
    async prepare(text) {
      const r = await args.post<{ pcmBase64: string; sampleRate: number }>(
        '/api/voice/direct/speak',
        {
          chatId: args.chatId,
          engine: args.engine,
          model: args.model,
          voice: args.voice,
          sound: args.sound,
          text,
        },
      );
      return args.play(bytesToPcm16(base64ToBytes(r.pcmBase64)), r.sampleRate);
    },
  };
}
