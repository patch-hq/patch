// The host's streaming recogniser for live dictation words (spec/07 §
// Dictation engines, `host`): NVIDIA's cache-aware streaming FastConformer
// transducer (480 ms chunks, int8) through sherpa-onnx. It processes each
// chunk of audio ONCE and keeps its state, so a long dictation costs the same
// per second as a short one and nothing is re-read.
//
// Its words are for watching: lower-case, no punctuation. The accurate words
// come from the offline Parakeet pass the session runs on each finished
// phrase (parakeet.ts), which replace these in place.
//
// Decoding is synchronous in sherpa's streaming API, so each live stream runs
// in its own worker thread — the host's event loop never waits on a model. A
// worker keeps its model loaded and is reused by the next dictation.
//
// The worker's source is inline (a string) so it needs no file beside the
// bundled host. NO FALLBACK: a model that will not load fails the dictation
// with the reason.

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';

export const PARAKEET_LIVE_MODEL_FILES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt',
] as const;

/** Quiet this long after speech ends a phrase, and starts its accurate read. */
const ENDPOINT_SILENCE_S = 0.5;
/** A phrase this long is ended even without a pause. */
const MAX_PHRASE_S = 25;

export type LiveEvent =
  /** The current phrase's words so far. */
  | { type: 'text'; text: string }
  /** The phrase is over: its words, and its stretch of the stream in samples. */
  | { type: 'phrase'; text: string; startSample: number; endSample: number }
  | { type: 'error'; message: string };

export interface LiveStream {
  /** Feed the next chunk of 16 kHz PCM. */
  accept(pcm: Int16Array): void;
  /** No more audio: resolves once the last words have been emitted. */
  finish(): Promise<void>;
  /** Drop the stream (a cancelled or failed dictation). The worker is kept for reuse. */
  close(): void;
}

export interface LiveRecognizer {
  open(onEvent: (ev: LiveEvent) => void): LiveStream;
  /** Load the model now, so a broken install fails at boot. */
  warm(): Promise<void>;
  close(): Promise<void>;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
let rec, stream, fed = 0, segStart = 0, last = '';
function post(m) { parentPort.postMessage(m); }
function decodeReady() { while (rec.isReady(stream)) rec.decode(stream); }
function emit(flushAll) {
  const text = rec.getResult(stream).text.trim();
  if (text !== last) { last = text; post({ t: 'text', text }); }
  if (flushAll || rec.isEndpoint(stream)) {
    if (text) post({ t: 'phrase', text, start: segStart, end: fed });
    rec.reset(stream); segStart = fed; last = '';
  }
}
try {
  const sherpa = require(workerData.sherpa);
  const d = workerData.dir + '/';
  rec = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: d + 'encoder.int8.onnx', decoder: d + 'decoder.int8.onnx', joiner: d + 'joiner.int8.onnx' },
      tokens: d + 'tokens.txt', numThreads: 1, provider: 'cpu', debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: workerData.silence,
    rule3MinUtteranceLength: workerData.maxPhrase,
  });
  stream = rec.createStream();
  post({ t: 'ready' });
} catch (e) { post({ t: 'error', message: String(e && e.message || e) }); }
parentPort.on('message', (m) => {
  try {
    if (m.t === 'audio') {
      stream.acceptWaveform({ sampleRate: 16000, samples: m.samples });
      fed += m.samples.length; decodeReady(); emit(false);
    } else if (m.t === 'finish') {
      stream.inputFinished(); decodeReady(); emit(true); post({ t: 'finished' });
    } else if (m.t === 'reset') {
      rec.reset(stream); stream = rec.createStream(); fed = 0; segStart = 0; last = '';
    }
  } catch (e) { post({ t: 'error', message: String(e && e.message || e) }); }
});
`;

interface Slot {
  worker: Worker;
  ready: Promise<void>;
  /** The stream using it now, if any. */
  handler: ((m: WorkerMessage) => void) | null;
  dead: boolean;
}

type WorkerMessage =
  | { t: 'ready' }
  | { t: 'text'; text: string }
  | { t: 'phrase'; text: string; start: number; end: number }
  | { t: 'finished' }
  | { t: 'error'; message: string };

export interface ParakeetLiveOptions {
  logger: Logger;
  /** PARAKEET_STREAMING_MODEL_DIR: the extracted streaming FastConformer transducer. */
  modelDir: string | undefined;
}

export class ParakeetLiveRecognizer implements LiveRecognizer {
  private readonly opts: ParakeetLiveOptions;
  private readonly idle: Slot[] = [];
  private readonly all = new Set<Slot>();

  constructor(opts: ParakeetLiveOptions) {
    this.opts = opts;
  }

  private spawn(): Slot {
    const dir = this.opts.modelDir;
    if (!dir) {
      throw new Error(
        'dictation on this host needs PARAKEET_STREAMING_MODEL_DIR (the extracted sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8 directory)',
      );
    }
    const missing = PARAKEET_LIVE_MODEL_FILES.filter((f) => !existsSync(join(dir, f)));
    if (missing.length > 0) {
      throw new Error(`streaming model dir ${dir} is missing: ${missing.join(', ')}`);
    }
    const sherpa = createRequire(import.meta.url).resolve('sherpa-onnx-node');
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { sherpa, dir, silence: ENDPOINT_SILENCE_S, maxPhrase: MAX_PHRASE_S },
    });
    const slot: Slot = { worker, ready: Promise.resolve(), handler: null, dead: false };
    slot.ready = new Promise<void>((resolve, reject) => {
      worker.on('message', (m: WorkerMessage) => {
        if (m.t === 'ready') resolve();
        else if (m.t === 'error' && slot.handler === null) reject(new Error(m.message));
        slot.handler?.(m);
      });
      worker.on('error', (err) => {
        slot.dead = true;
        reject(err);
        slot.handler?.({ t: 'error', message: err.message });
      });
      worker.on('exit', (code) => {
        slot.dead = true;
        this.all.delete(slot);
        const msg = `the streaming recogniser stopped (exit ${code})`;
        reject(new Error(msg));
        slot.handler?.({ t: 'error', message: msg });
      });
    });
    slot.ready.catch(() => undefined);
    this.all.add(slot);
    return slot;
  }

  private take(): Slot {
    for (;;) {
      const slot = this.idle.pop();
      if (!slot) return this.spawn();
      if (!slot.dead) return slot;
    }
  }

  async warm(): Promise<void> {
    const slot = this.spawn();
    await slot.ready;
    this.idle.push(slot);
    this.opts.logger.info({ dir: this.opts.modelDir }, 'parakeet-live: streaming model loaded');
  }

  open(onEvent: (ev: LiveEvent) => void): LiveStream {
    let slot: Slot;
    try {
      slot = this.take();
    } catch (err) {
      // Reported through the stream, like every later failure.
      queueMicrotask(() => onEvent({ type: 'error', message: (err as Error).message }));
      return { accept: () => undefined, finish: async () => undefined, close: () => undefined };
    }
    let finished: (() => void) | null = null;
    let errored = false;
    let released = false;
    const s = slot;
    s.handler = (m) => {
      if (m.t === 'text') onEvent({ type: 'text', text: m.text });
      else if (m.t === 'phrase') {
        onEvent({ type: 'phrase', text: m.text, startSample: m.start, endSample: m.end });
      } else if (m.t === 'finished') finished?.();
      else if (m.t === 'error') {
        errored = true;
        onEvent({ type: 'error', message: m.message });
        finished?.();
      }
    };
    const release = (): void => {
      if (released) return;
      released = true;
      s.handler = null;
      if (s.dead) return;
      s.worker.postMessage({ t: 'reset' });
      this.idle.push(s);
    };
    // Audio sent before the model has loaded is queued by the worker's port.
    s.ready.catch((err: Error) => onEvent({ type: 'error', message: err.message }));
    return {
      accept: (pcm) => {
        const samples = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 32768;
        s.worker.postMessage({ t: 'audio', samples }, [samples.buffer]);
      },
      finish: () =>
        new Promise<void>((resolve) => {
          if (errored || s.dead) return resolve();
          finished = resolve;
          s.worker.postMessage({ t: 'finish' });
        }),
      close: release,
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.all].map((s) => s.worker.terminate()));
    this.idle.length = 0;
    this.all.clear();
  }
}
