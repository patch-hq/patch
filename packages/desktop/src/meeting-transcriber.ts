// Meeting transcription on this device (spec/07 § Meeting transcription).
//
// The mic and the call audio are transcribed here, by Parakeet TDT v3 through
// sherpa-onnx, and only text leaves the machine. Each source is cut at pauses by
// a Silero voice-activity detector, so a line is a whole utterance rather than a
// fixed slice that splits words, and silence never reaches the recogniser (which
// is what made the old clip path invent "Thank you." from a quiet call).
//
// While someone is still talking, the utterance so far is re-read about twice a
// second and reported as a partial; when they pause, the whole utterance is read
// once more and reported as final. One decode runs at a time: finals queue in
// order, and a partial is skipped while anything else is decoding.
//
// No electron import: the replay tool (scripts/meeting-replay.ts) runs this same
// module in plain Node. NO FALLBACK: a missing model or a failed decode is an
// error the caller shows.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const SAMPLE_RATE = 16000;
export type MeetingSource = 'mic' | 'system';

/** The files the Parakeet dir must hold (sherpa-onnx int8 export). */
export const PARAKEET_FILES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt',
] as const;

/** Silero's analysis window at 16 kHz. */
const VAD_WINDOW = 512;
/** A pause this long ends an utterance. Short, so a line lands soon after it is said. */
const MIN_SILENCE_SECONDS = 0.4;
/** Longer speech is cut here, so a monologue still lands in pieces. */
const MAX_SPEECH_SECONDS = 12;
/** Audio between two partial passes over the same utterance. */
const PARTIAL_STEP_SAMPLES = Math.round(0.5 * SAMPLE_RATE);
/** Audio kept before the detector fires, so the first word is not clipped. */
const LEAD_SAMPLES = Math.round(0.3 * SAMPLE_RATE);
/** How long a mic line may wait for the call audio it could be an echo of. */
const ECHO_HOLD_MS = 4000;
/** A mic line no longer than this, heard wholly inside call speech, is taken as echo. */
const SHORT_ECHO_WORDS = 2;
/** A mic line this much contained in what the call said at the same moment is its echo. */
const ECHO_CONTAINED = 0.75;
/** Recent audio kept per source for partials. */
const HISTORY_SAMPLES = (MAX_SPEECH_SECONDS + 2) * SAMPLE_RATE;

export interface TranscriptText {
  source: MeetingSource;
  text: string;
  /** Wall-clock ms the utterance began. */
  startedAt: number;
  /** Wall-clock ms the utterance ended (for a partial, the latest audio read). */
  endedAt: number;
  final: boolean;
}

interface SherpaStream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void;
}
interface SherpaRecognizer {
  createStream(): SherpaStream;
  decodeAsync(stream: SherpaStream): Promise<{ text: string }>;
}
interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  isDetected(): boolean;
  front(enableExternalBuffer?: boolean): { samples: Float32Array; start: number };
  pop(): void;
  flush(): void;
}
export interface SherpaModule {
  OfflineRecognizer: new (config: unknown) => SherpaRecognizer;
  Vad: new (config: unknown, bufferSizeInSeconds: number) => SherpaVad;
}

export interface MeetingTranscriberOptions {
  /** The extracted sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 directory. */
  parakeetDir: string;
  /** silero_vad.onnx. */
  vadModel: string;
  onText: (t: TranscriptText) => void;
  onError: (err: Error) => void;
  threads?: number;
  /** Test hook. */
  loadSherpa?: () => SherpaModule;
}

interface Lane {
  vad: SherpaVad;
  /** Samples not yet a whole VAD window. */
  pending: Float32Array;
  /** Samples this lane has fed the detector. */
  fed: number;
  /** Wall-clock ms of the lane's first sample. */
  origin: number | null;
  /** The last HISTORY_SAMPLES samples fed, for partials. */
  history: Float32Array;
  historyEnd: number;
  /** Where the utterance in progress began (lane sample index), or null when quiet. */
  speechFrom: number | null;
  partialAt: number;
}

const echoWords = (t: string): string[] =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');

/**
 * True when most of a mic line's words were said on the call around the same
 * time: what the echo canceller left of the call playing from the speakers.
 */
export function isEchoOf(micText: string, callTexts: string[]): boolean {
  const words = echoWords(micText);
  if (words.length === 0) return false;
  const pool = new Set(callTexts.flatMap(echoWords));
  return words.filter((w) => pool.has(w)).length / words.length >= ECHO_CONTAINED;
}

/** sherpa-onnx's native addon, loaded on first use so the app starts without it. */
function loadSherpa(): SherpaModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('sherpa-onnx-node') as SherpaModule;
}

export function missingModelFiles(parakeetDir: string, vadModel: string): string[] {
  const missing: string[] = PARAKEET_FILES.filter((f) => !existsSync(join(parakeetDir, f))).map(
    (f) => join(parakeetDir, f),
  );
  if (!existsSync(vadModel)) missing.push(vadModel);
  return missing;
}

export class MeetingTranscriber {
  private readonly sherpa: SherpaModule;
  private readonly recognizer: SherpaRecognizer;
  private readonly lanes = new Map<MeetingSource, Lane>();
  private queue: Promise<void> = Promise.resolve();
  private busy = 0;
  private closed = false;
  /** Mic finals waiting to be checked against the call audio of the same moment. */
  private held: TranscriptText[] = [];
  /** Recent call finals, for that check. */
  private heard: TranscriptText[] = [];
  /** The call side's utterance in progress, as far as it has been read. */
  private callPartial: TranscriptText | null = null;
  /** Wall clock of the latest audio fed. */
  private latest = 0;

  constructor(private readonly opts: MeetingTranscriberOptions) {
    const missing = missingModelFiles(opts.parakeetDir, opts.vadModel);
    if (missing.length > 0) {
      throw new Error(`Meeting transcription model is missing: ${missing.join(', ')}`);
    }
    this.sherpa = opts.loadSherpa ? opts.loadSherpa() : loadSherpa();
    const dir = opts.parakeetDir;
    this.recognizer = new this.sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join(dir, 'encoder.int8.onnx'),
          decoder: join(dir, 'decoder.int8.onnx'),
          joiner: join(dir, 'joiner.int8.onnx'),
        },
        tokens: join(dir, 'tokens.txt'),
        numThreads: opts.threads ?? 2,
        provider: 'cpu',
        debug: 0,
        modelType: 'nemo_transducer',
      },
    });
  }

  private lane(source: MeetingSource): Lane {
    let lane = this.lanes.get(source);
    if (!lane) {
      lane = {
        vad: new this.sherpa.Vad(
          {
            sileroVad: {
              model: this.opts.vadModel,
              threshold: 0.5,
              minSilenceDuration: MIN_SILENCE_SECONDS,
              minSpeechDuration: 0.25,
              maxSpeechDuration: MAX_SPEECH_SECONDS,
              windowSize: VAD_WINDOW,
            },
            sampleRate: SAMPLE_RATE,
            numThreads: 1,
            provider: 'cpu',
            debug: 0,
          },
          MAX_SPEECH_SECONDS * 3,
        ),
        pending: new Float32Array(0),
        fed: 0,
        origin: null,
        history: new Float32Array(HISTORY_SAMPLES),
        historyEnd: 0,
        speechFrom: null,
        partialAt: 0,
      };
      this.lanes.set(source, lane);
    }
    return lane;
  }

  /**
   * Feed 16 kHz mono PCM16 for one source. `at` is the wall-clock ms the chunk's
   * last sample was captured; the first chunk fixes the lane's clock.
   */
  push(source: MeetingSource, pcm: Int16Array, at: number = Date.now()): void {
    if (this.closed) throw new Error('meeting transcriber is closed');
    const lane = this.lane(source);
    this.latest = Math.max(this.latest, at);
    if (lane.origin === null) lane.origin = at - (pcm.length / SAMPLE_RATE) * 1000;
    const joined = new Float32Array(lane.pending.length + pcm.length);
    joined.set(lane.pending);
    for (let i = 0; i < pcm.length; i++) joined[lane.pending.length + i] = (pcm[i] ?? 0) / 32768;
    let o = 0;
    for (; o + VAD_WINDOW <= joined.length; o += VAD_WINDOW) {
      const win = joined.subarray(o, o + VAD_WINDOW);
      this.remember(lane, win);
      lane.vad.acceptWaveform(win);
      lane.fed += VAD_WINDOW;
      this.afterWindow(source, lane);
    }
    lane.pending = joined.slice(o);
    this.release(false);
  }

  private remember(lane: Lane, win: Float32Array): void {
    const h = lane.history;
    const start = lane.historyEnd % h.length;
    const first = Math.min(win.length, h.length - start);
    h.set(win.subarray(0, first), start);
    if (first < win.length) h.set(win.subarray(first), 0);
    lane.historyEnd += win.length;
  }

  /** Samples [from, lane.historyEnd) from the history ring. */
  private recall(lane: Lane, from: number): Float32Array {
    const h = lane.history;
    const begin = Math.max(from, lane.historyEnd - h.length);
    const out = new Float32Array(lane.historyEnd - begin);
    for (let i = 0; i < out.length; i++) out[i] = h[(begin + i) % h.length]!;
    return out;
  }

  private wall(lane: Lane, sample: number): number {
    return (lane.origin ?? 0) + (sample / SAMPLE_RATE) * 1000;
  }

  private afterWindow(source: MeetingSource, lane: Lane): void {
    while (!lane.vad.isEmpty()) {
      const seg = lane.vad.front(false);
      lane.vad.pop();
      lane.speechFrom = null;
      const samples = Float32Array.from(seg.samples);
      const startedAt = this.wall(lane, seg.start);
      const endedAt = this.wall(lane, seg.start + samples.length);
      this.decode(samples, (text) => this.emit({ source, text, startedAt, endedAt, final: true }));
    }
    if (lane.vad.isDetected()) {
      if (lane.speechFrom === null) {
        lane.speechFrom = Math.max(0, lane.fed - VAD_WINDOW * 8 - LEAD_SAMPLES);
        lane.partialAt = lane.fed;
      }
      if (lane.fed - lane.partialAt >= PARTIAL_STEP_SAMPLES && this.busy === 0) {
        lane.partialAt = lane.fed;
        const from = lane.speechFrom;
        const audio = this.recall(lane, from);
        const startedAt = this.wall(lane, from);
        const endedAt = this.wall(lane, lane.fed);
        this.decode(audio, (text) => {
          // A final for this utterance may have landed while the partial ran.
          if (lane.speechFrom === from)
            this.emit({ source, text, startedAt, endedAt, final: false });
        });
      }
    } else if (lane.speechFrom !== null && lane.vad.isEmpty()) {
      // Detection dropped without a segment (too short to count): forget it.
      lane.speechFrom = null;
    }
  }

  private emit(t: TranscriptText): void {
    if (t.text === '') return;
    // With call audio to compare against, a mic final waits until the call side
    // of the same moment is known, and is dropped if it only repeats it.
    if (t.final && t.source === 'mic' && this.lanes.has('system')) {
      this.held.push(t);
      this.release(false);
      return;
    }
    if (t.source === 'system') this.callPartial = t.final ? null : t;
    if (t.final && t.source === 'system') {
      this.heard.push(t);
      this.heard = this.heard.filter((h) => h.endedAt > t.endedAt - 60_000);
    }
    this.opts.onText(t);
    if (t.final && t.source === 'system') this.release(false);
  }

  /** Let go of mic finals whose moment the call side has caught up with (all of them when `all`). */
  private release(all: boolean): void {
    if (this.held.length === 0) return;
    const call = this.lanes.get('system');
    // The call side is still mid-utterance from this time; anything it covers is not settled.
    const open = call?.speechFrom != null ? this.wall(call, call.speechFrom) : Infinity;
    const keep: TranscriptText[] = [];
    for (const m of this.held) {
      const settled = all || m.endedAt < open - 500 || this.latest - m.endedAt > ECHO_HOLD_MS;
      if (!settled) {
        keep.push(m);
        continue;
      }
      const call = [...this.heard, ...(this.callPartial ? [this.callPartial] : [])];
      const around = call
        .filter((h) => h.endedAt > m.startedAt - 2000 && h.startedAt < m.endedAt + 2000)
        .map((h) => h.text);
      if (isEchoOf(m.text, around)) continue;
      // A word or two heard entirely while the call was talking is what the canceller
      // left of it, garbled past matching ("Oh.", "Green."), not someone speaking.
      const inside = call.some(
        (h) => h.startedAt <= m.startedAt + 300 && h.endedAt >= m.endedAt - 300,
      );
      if (inside && echoWords(m.text).length <= SHORT_ECHO_WORDS) continue;
      this.opts.onText(m);
    }
    this.held = keep;
  }

  private decode(samples: Float32Array, done: (text: string) => void): void {
    this.busy++;
    const run = this.queue.then(async () => {
      const stream = this.recognizer.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      const result = await this.recognizer.decodeAsync(stream);
      done(result.text.trim());
    });
    this.queue = run
      .catch((err: unknown) =>
        this.opts.onError(err instanceof Error ? err : new Error(String(err))),
      )
      .finally(() => {
        this.busy--;
      });
  }

  /** End every utterance in progress and wait for its final. Further pushes start new ones. */
  async flush(): Promise<void> {
    for (const [source, lane] of this.lanes) {
      if (lane.pending.length > 0) {
        const pad = new Float32Array(VAD_WINDOW);
        pad.set(lane.pending);
        lane.pending = new Float32Array(0);
        this.remember(lane, pad);
        lane.vad.acceptWaveform(pad);
        lane.fed += VAD_WINDOW;
      }
      lane.vad.flush();
      this.afterWindow(source, lane);
      lane.speechFrom = null;
    }
    await this.queue;
    this.release(true);
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    this.lanes.clear();
  }
}
