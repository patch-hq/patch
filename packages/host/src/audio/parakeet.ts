// Parakeet STT backend (WHISPER_BACKEND=parakeet): NVIDIA Parakeet TDT v3 run
// on this machine's CPU through sherpa-onnx (spec/07 § Dictation engines).
//
// It replaces the rationed Groq re-read as the default words engine: nothing
// leaves the machine, nothing is billed, there is no per-minute quota, and the
// model punctuates and capitalises itself. The model is offline (not
// streaming), so the live preview re-reads the growing utterance — the same
// shape the Groq path had, but unmetered, so it can run about twice a second.
//
// The decode runs on sherpa's own thread pool (`decodeAsync`), never on the
// event loop, and one decode runs at a time: a live pass in flight holds the
// final behind it by at most the length of one pass.
//
// NO FALLBACK: a model that will not load, a missing `ffmpeg` for a compressed
// clip, an empty model dir — each is an error naming what is missing.

import type { Logger } from 'pino';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ClipOptions, TranscribeOptions, WhisperBackend } from './whisper.js';
import { pcmFromWav } from './smartTurn.js';

const SAMPLE_RATE = 16000;
/** New audio between two live passes: 0.5 s. Unmetered, so tighter than Groq's 1 s. */
export const PARAKEET_PARTIAL_STEP_SAMPLES = 8000;
/**
 * Threads for one decode. Measured on the 16-core netcup host: 2 threads decode
 * at about 0.18x real time and 4 are no faster while burning twice the CPU.
 */
const DEFAULT_THREADS = 2;
/** A live pass re-reads about this much audio past the frozen head. */
const LIVE_WINDOW_SAMPLES = 5 * SAMPLE_RATE;
/** Context kept behind a freeze point, so the words after it are read with their lead-in. */
const FREEZE_LEAD_SECONDS = 1.5;

interface SherpaStream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void;
}
interface SherpaResult {
  text: string;
  tokens?: string[];
  timestamps?: number[];
  durations?: number[];
}
interface SherpaRecognizer {
  createStream(): SherpaStream;
  decodeAsync(stream: SherpaStream): Promise<SherpaResult>;
}

/**
 * The part of a growing utterance a live pass no longer re-reads: words that
 * ended a sentence well behind the live edge, read once with full context.
 */
interface FrozenHead {
  samples: number;
  text: string;
  fingerprint: string;
}

/** Cheap identity of the first `n` samples, to tell a growing prefix from a new utterance. */
function fingerprint(pcm: Int16Array, n: number): string {
  const stride = Math.max(1, Math.floor(n / 64));
  let h = 0;
  for (let i = 0; i < n; i += stride) h = (Math.imul(h, 31) + (pcm[i] ?? 0)) | 0;
  return `${n}:${h}`;
}

const BOUNDARY = /[.?!,;:]$/;
interface SherpaModule {
  OfflineRecognizer: new (config: unknown) => SherpaRecognizer;
}

/** The files a Parakeet TDT model dir must hold (sherpa-onnx int8 export). */
export const PARAKEET_MODEL_FILES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt',
] as const;

export interface ParakeetOptions {
  logger: Logger;
  /** PARAKEET_MODEL_DIR: the extracted `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`. */
  modelDir: string | undefined;
  threads?: number;
  /** Test hook: substitute the sherpa module. */
  loadSherpa?: () => Promise<SherpaModule>;
  /** Test hook: substitute ffmpeg decoding of a compressed clip to 16 kHz PCM. */
  decodeClip?: (audio: Buffer) => Promise<Int16Array>;
}

export class ParakeetWhisperBackend implements WhisperBackend {
  readonly supportsLivePartials = true;
  readonly livePartialStepSamples = PARAKEET_PARTIAL_STEP_SAMPLES;
  private readonly opts: ParakeetOptions;
  private recognizer?: Promise<SherpaRecognizer>;
  private head?: FrozenHead;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: ParakeetOptions) {
    this.opts = opts;
  }

  /** Load the model now, so a broken install fails at boot rather than at the first word. */
  async warm(): Promise<void> {
    await this.load();
  }

  private load(): Promise<SherpaRecognizer> {
    this.recognizer ??= this.build().catch((err) => {
      this.recognizer = undefined;
      throw err;
    });
    return this.recognizer;
  }

  private async build(): Promise<SherpaRecognizer> {
    const dir = this.opts.modelDir;
    if (!dir) {
      throw new Error(
        'WHISPER_BACKEND=parakeet needs PARAKEET_MODEL_DIR (the extracted sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 directory)',
      );
    }
    const missing = PARAKEET_MODEL_FILES.filter((f) => !existsSync(join(dir, f)));
    if (missing.length > 0) {
      throw new Error(`Parakeet model dir ${dir} is missing: ${missing.join(', ')}`);
    }
    const sherpa = await (this.opts.loadSherpa
      ? this.opts.loadSherpa()
      : (import('sherpa-onnx-node') as unknown as Promise<SherpaModule>));
    const started = Date.now();
    const recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join(dir, 'encoder.int8.onnx'),
          decoder: join(dir, 'decoder.int8.onnx'),
          joiner: join(dir, 'joiner.int8.onnx'),
        },
        tokens: join(dir, 'tokens.txt'),
        numThreads: this.opts.threads ?? DEFAULT_THREADS,
        provider: 'cpu',
        debug: 0,
        modelType: 'nemo_transducer',
      },
    });
    this.opts.logger.info({ ms: Date.now() - started, dir }, 'parakeet: model loaded');
    return recognizer;
  }

  async transcribe(pcm: Int16Array, opts?: TranscribeOptions): Promise<string> {
    // One decode at a time, in the order asked: a final never overtakes the
    // pass that was already running, and never waits behind a later one.
    const live = opts?.priority === 'partial';
    const run = this.queue.then(() => (live ? this.decodeLive(pcm) : this.decode(pcm)));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async decodeFull(pcm: Int16Array): Promise<SherpaResult> {
    const recognizer = await this.load();
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 32768;
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    return recognizer.decodeAsync(stream);
  }

  /** The whole audio, read once, with full context. What a final always is. */
  private async decode(pcm: Int16Array): Promise<string> {
    return (await this.decodeFull(pcm)).text.trim();
  }

  /**
   * A live pass over the growing utterance. Past five seconds of tail it stops
   * re-reading the start: the sentences that ended well behind the live edge
   * are frozen as they were read, and only the audio after them is decoded. So
   * a long dictation costs a bounded pass, not one that grows with every word.
   */
  private async decodeLive(pcm: Int16Array): Promise<string> {
    let head = this.head;
    if (
      head &&
      (pcm.length < head.samples || fingerprint(pcm, head.samples) !== head.fingerprint)
    ) {
      head = undefined;
    }
    const from = head?.samples ?? 0;
    const result = await this.decodeFull(from === 0 ? pcm : pcm.subarray(from));
    const tail = result.text.trim();
    const lead = head?.text ?? '';
    this.head = head;
    const tailSamples = pcm.length - from;
    if (tailSamples > LIVE_WINDOW_SAMPLES && result.tokens && result.timestamps) {
      const limit = tailSamples / SAMPLE_RATE - FREEZE_LEAD_SECONDS;
      let cut = -1;
      for (let i = 0; i < result.tokens.length; i++) {
        const end = (result.timestamps[i] ?? 0) + (result.durations?.[i] ?? 0);
        if (end > limit) break;
        if (BOUNDARY.test(result.tokens[i]!.trim())) cut = i;
      }
      if (cut >= 0) {
        const samples =
          from +
          Math.round(
            ((result.timestamps[cut] ?? 0) + (result.durations?.[cut] ?? 0)) * SAMPLE_RATE,
          );
        this.head = {
          samples,
          text: `${lead} ${result.tokens.slice(0, cut + 1).join('')}`.trim(),
          fingerprint: fingerprint(pcm, samples),
        };
      }
    }
    return `${lead} ${tail}`.trim();
  }

  async transcribeClip(audio: Buffer, format: 'm4a' | 'wav', _opts?: ClipOptions): Promise<string> {
    const pcm =
      format === 'wav'
        ? pcmFromWav(audio)
        : await (this.opts.decodeClip ?? decodeWithFfmpeg)(audio);
    return this.transcribe(pcm, { priority: 'final' });
  }

  async close(): Promise<void> {
    await this.queue;
    this.recognizer = undefined;
  }
}

/** Compressed clips (a phone's m4a) are decoded to 16 kHz mono PCM by ffmpeg. */
export function decodeWithFfmpeg(audio: Buffer): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ar',
        String(SAMPLE_RATE),
        '-ac',
        '1',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const out: Buffer[] = [];
    let err = '';
    proc.stdout.on('data', (b: Buffer) => out.push(b));
    proc.stderr.on('data', (b: Buffer) => (err += b.toString()));
    proc.on('error', (e) =>
      reject(
        new Error(
          `Parakeet needs ffmpeg to read a compressed clip, and it could not be run: ${e.message}`,
        ),
      ),
    );
    proc.on('close', (code) => {
      if (code !== 0)
        return reject(new Error(`ffmpeg could not decode the clip (exit ${code}): ${err.trim()}`));
      const buf = Buffer.concat(out);
      resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)).slice());
    });
    proc.stdin.on('error', () => undefined);
    proc.stdin.end(audio);
  });
}
