// Who is speaking on a voice device (spec/16 § Who is speaking).
//
// A voiceprint is a speaker embedding: sherpa-onnx's SpeakerEmbeddingExtractor
// running WeSpeaker's ResNet34 model, which turns a stretch of 16 kHz speech
// into 256 numbers that sit close together for the same voice. Matching them
// against the account's profiles is `identifyVoice` in @patch/wire.
//
// One extraction takes 70-200 ms of CPU, so it runs on a worker thread: on the
// main thread it would stall every audio relay the host is carrying.
//
// The model is its own small component (`speaker`, components.ts) and sherpa
// comes from the voice component. NO FALLBACK: without either, an embed fails
// by name and the caller reports it.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { VOICEPRINT_DIM, type RecentVoice } from '@patch/wire';

export const SPEAKER_COMPONENT_ID = 'speaker';
export const SPEAKER_MODEL_FILE = 'wespeaker_en_voxceleb_resnet34_LM.onnx';
/** Shorter than this and a voiceprint says little about who it was. */
export const MIN_VOICEPRINT_SECONDS = 1;
/** Longer than this adds nothing; the tail is dropped. */
export const MAX_VOICEPRINT_SECONDS = 20;

export class SpeakerIdUnavailableError extends Error {
  readonly code = 'voice_component_missing' as const;
}

export class TooShortError extends Error {
  readonly code = 'too_short' as const;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
let ex;
try {
  const sherpa = require(workerData.sherpa);
  ex = new sherpa.SpeakerEmbeddingExtractor({ model: workerData.model, numThreads: 1, debug: false });
  parentPort.postMessage({ t: 'ready', dim: ex.dim });
} catch (e) { parentPort.postMessage({ t: 'error', message: String(e && e.message || e) }); }
parentPort.on('message', (m) => {
  try {
    const s = ex.createStream();
    s.acceptWaveform({ sampleRate: 16000, samples: m.samples });
    s.inputFinished();
    if (!ex.isReady(s)) throw new Error('not enough audio for a voiceprint');
    parentPort.postMessage({ t: 'vp', id: m.id, v: Array.from(ex.compute(s)) });
  } catch (e) { parentPort.postMessage({ t: 'fail', id: m.id, message: String(e && e.message || e) }); }
});
`;

type WorkerMessage =
  | { t: 'ready'; dim: number }
  | { t: 'error'; message: string }
  | { t: 'vp'; id: string; v: number[] }
  | { t: 'fail'; id: string; message: string };

export interface SpeakerIdOptions {
  logger: Logger;
  /** The model file, when the `speaker` component is installed. */
  modelPath: () => string | undefined;
  /** sherpa-onnx-node's entry (the voice component's copy on an installed host). */
  sherpaEntry?: () => string | undefined;
}

export class SpeakerId {
  private readonly opts: SpeakerIdOptions;
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private readonly waiting = new Map<
    string,
    { resolve: (v: number[]) => void; reject: (e: Error) => void }
  >();

  constructor(opts: SpeakerIdOptions) {
    this.opts = opts;
  }

  /** Whether voiceprints can be computed here now. */
  available(): boolean {
    const model = this.opts.modelPath();
    if (model === undefined || !existsSync(model)) return false;
    try {
      this.sherpa();
      return true;
    } catch {
      return false;
    }
  }

  /** Load the model now rather than on the first embed. A failure is the first embed's to report. */
  warm(): void {
    this.start().catch(() => undefined);
  }

  private sherpa(): string {
    return this.opts.sherpaEntry?.() ?? createRequire(import.meta.url).resolve('sherpa-onnx-node');
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const model = this.opts.modelPath();
    if (model === undefined || !existsSync(model)) {
      return Promise.reject(
        new SpeakerIdUnavailableError(
          'Voice profiles need the Speaker recognition component on this host. Install it in Settings → Hosts → Components.',
        ),
      );
    }
    let sherpa: string;
    try {
      sherpa = this.sherpa();
    } catch (err) {
      return Promise.reject(new SpeakerIdUnavailableError((err as Error).message));
    }
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { sherpa, model } });
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      worker.on('message', (m: WorkerMessage) => {
        if (m.t === 'ready') {
          if (m.dim !== VOICEPRINT_DIM) {
            reject(new Error(`speaker model gives ${m.dim} numbers, expected ${VOICEPRINT_DIM}`));
            return;
          }
          resolve();
        } else if (m.t === 'error') reject(new SpeakerIdUnavailableError(m.message));
        else {
          const w = this.waiting.get(m.id);
          if (!w) return;
          this.waiting.delete(m.id);
          if (m.t === 'vp') w.resolve(m.v);
          else w.reject(new Error(m.message));
        }
      });
      worker.on('error', (err) => this.fail(err, reject));
      worker.on('exit', (code) => this.fail(new Error(`speaker worker exited (${code})`), reject));
    });
    // A failed start is retried on the next embed, after a component install.
    this.ready.catch(() => {
      this.ready = null;
      this.worker = null;
    });
    return this.ready;
  }

  private fail(err: Error, reject: (e: Error) => void): void {
    reject(err);
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
    this.worker = null;
    this.ready = null;
  }

  /** The voiceprint of 16 kHz PCM16 speech. */
  async embed(pcm: Int16Array): Promise<number[]> {
    const seconds = pcm.length / 16000;
    if (seconds < MIN_VOICEPRINT_SECONDS) {
      throw new TooShortError(
        `a voiceprint needs at least ${MIN_VOICEPRINT_SECONDS} s of speech (got ${seconds.toFixed(1)} s)`,
      );
    }
    await this.start();
    const n = Math.min(pcm.length, MAX_VOICEPRINT_SECONDS * 16000);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = pcm[i]! / 32768;
    const id = randomUUID();
    return new Promise<number[]>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker!.postMessage({ id, samples }, [samples.buffer]);
    });
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.ready = null;
    if (w) await w.terminate();
  }
}

/**
 * The voices this host's devices heard lately, newest first, so Settings can
 * say "that was Eleanor". In memory only: a restart forgets them, and nothing
 * here is the chat's record.
 */
export class RecentVoices {
  private readonly items: RecentVoice[] = [];
  constructor(private readonly max = 20) {}

  add(v: Omit<RecentVoice, 'id'>): string {
    const id = randomUUID();
    this.items.unshift({ id, ...v });
    this.items.length = Math.min(this.items.length, this.max);
    return id;
  }

  /** Fill in what was said once the transcript lands. */
  setText(id: string, text: string): void {
    const item = this.items.find((v) => v.id === id);
    if (item) item.text = text;
  }

  list(): RecentVoice[] {
    return this.items.map((v) => ({ ...v }));
  }
}

/**
 * The speaker model's path when the `speaker` component is installed under
 * `componentsRoot`, else undefined. `SPEAKER_MODEL_PATH` names one directly
 * (a source checkout has no components).
 */
export function speakerModelPath(componentsRoot: string): string | undefined {
  const override = process.env.SPEAKER_MODEL_PATH;
  if (override) return override;
  const dir = join(componentsRoot, SPEAKER_COMPONENT_ID);
  const record = join(dir, 'install-state.json');
  if (!existsSync(record)) return undefined;
  try {
    const state = (JSON.parse(readFileSync(record, 'utf8')) as { state?: unknown }).state;
    return state === 'installed' ? join(dir, SPEAKER_MODEL_FILE) : undefined;
  } catch {
    return undefined;
  }
}
