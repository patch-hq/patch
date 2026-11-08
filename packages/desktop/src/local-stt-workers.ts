// The real engines behind local dictation (local-stt.ts): sherpa-onnx's
// streaming recogniser and its offline Parakeet TDT recogniser, each in its own
// worker thread so the app's main process never waits on a model. Same
// configuration as the host's (packages/host/src/audio/parakeet*.ts); the
// worker sources are inline strings so they need no file beside the bundle.
//
// NO FALLBACK: a model or addon that will not load fails the dictation with
// the reason.

import { Worker } from 'node:worker_threads';
import type { AccurateEngine, LiveEngine, LiveEvent, LiveStream } from './local-stt';

/** Quiet this long after speech ends a phrase, and starts its accurate read. */
const ENDPOINT_SILENCE_S = 0.5;
/** A phrase this long is ended even without a pause. */
const MAX_PHRASE_S = 25;

const LIVE_SOURCE = `
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

const ACCURATE_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
let rec;
try {
  const sherpa = require(workerData.sherpa);
  const d = workerData.dir + '/';
  rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: d + 'encoder.int8.onnx', decoder: d + 'decoder.int8.onnx', joiner: d + 'joiner.int8.onnx' },
      tokens: d + 'tokens.txt', numThreads: 2, provider: 'cpu', debug: 0, modelType: 'nemo_transducer',
    },
  });
  parentPort.postMessage({ t: 'ready' });
} catch (e) { parentPort.postMessage({ t: 'error', message: String(e && e.message || e) }); }
parentPort.on('message', (m) => {
  try {
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: m.samples });
    rec.decode(stream);
    parentPort.postMessage({ t: 'text', id: m.id, text: rec.getResult(stream).text.trim() });
  } catch (e) { parentPort.postMessage({ t: 'error', id: m.id, message: String(e && e.message || e) }); }
});
`;

function toFloat(pcm: Int16Array): Float32Array {
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 32768;
  return samples;
}

export interface EngineOptions {
  /** Absolute path of the sherpa-onnx-node package (outside the asar). */
  sherpa: string;
  liveDir: string;
  accurateDir: string;
}

type LiveMessage =
  | { t: 'ready' }
  | { t: 'text'; text: string }
  | { t: 'phrase'; text: string; start: number; end: number }
  | { t: 'finished' }
  | { t: 'error'; message: string };

/** One streaming worker per dictation, ended with it: a dictation is short and a fresh worker is a clean state. */
export class SherpaLiveEngine implements LiveEngine {
  constructor(private readonly o: EngineOptions) {}

  open(onEvent: (ev: LiveEvent) => void): LiveStream {
    const worker = new Worker(LIVE_SOURCE, {
      eval: true,
      workerData: {
        sherpa: this.o.sherpa,
        dir: this.o.liveDir,
        silence: ENDPOINT_SILENCE_S,
        maxPhrase: MAX_PHRASE_S,
      },
    });
    let finished: (() => void) | null = null;
    let dead = false;
    const fail = (message: string): void => {
      dead = true;
      onEvent({ type: 'error', message });
      finished?.();
    };
    worker.on('message', (m: LiveMessage) => {
      if (m.t === 'text') onEvent({ type: 'text', text: m.text });
      else if (m.t === 'phrase') {
        onEvent({ type: 'phrase', text: m.text, startSample: m.start, endSample: m.end });
      } else if (m.t === 'finished') finished?.();
      else if (m.t === 'error') fail(m.message);
    });
    worker.on('error', (err) => fail(err.message));
    worker.on('exit', (code) => {
      if (!dead && finished) fail(`the streaming recogniser stopped (exit ${code})`);
    });
    return {
      accept: (pcm) => {
        const samples = toFloat(pcm);
        worker.postMessage({ t: 'audio', samples }, [samples.buffer]);
      },
      finish: () =>
        new Promise<void>((resolve) => {
          if (dead) return resolve();
          finished = resolve;
          worker.postMessage({ t: 'finish' });
        }),
      close: () => {
        void worker.terminate();
      },
    };
  }
}

/** The accurate recogniser: one worker kept for the app's life, loaded on first use. */
export class SherpaAccurateEngine implements AccurateEngine {
  private worker: Worker | null = null;
  private nextId = 0;
  private readonly waiting = new Map<number, { ok(t: string): void; bad(e: Error): void }>();

  constructor(private readonly o: EngineOptions) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(ACCURATE_SOURCE, {
      eval: true,
      workerData: { sherpa: this.o.sherpa, dir: this.o.accurateDir },
    });
    const failAll = (err: Error): void => {
      this.worker = null;
      for (const w of this.waiting.values()) w.bad(err);
      this.waiting.clear();
    };
    worker.on('message', (m: { t: string; id?: number; text?: string; message?: string }) => {
      if (m.t === 'error' && m.id === undefined) return failAll(new Error(m.message));
      if (m.id === undefined) return;
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.t === 'text') w?.ok(m.text ?? '');
      else if (m.t === 'error') w?.bad(new Error(m.message));
    });
    worker.on('error', (err) => failAll(err));
    worker.on('exit', (code) =>
      failAll(new Error(`the accurate recogniser stopped (exit ${code})`)),
    );
    this.worker = worker;
    return worker;
  }

  transcribe(pcm: Int16Array): Promise<string> {
    const worker = this.start();
    return new Promise<string>((ok, bad) => {
      const id = this.nextId++;
      this.waiting.set(id, { ok, bad });
      const samples = toFloat(pcm);
      worker.postMessage({ id, samples }, [samples.buffer]);
    });
  }

  async close(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
  }
}
