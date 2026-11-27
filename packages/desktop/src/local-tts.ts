// Kokoro on this computer (spec/07 § Direct calls): the desktop app's own text
// to speech for a direct call, downloaded on demand into its models folder like
// Parakeet, and run by sherpa-onnx in a worker thread so the main process never
// waits on a synthesis. 24 kHz mono PCM16 out.
//
// NO FALLBACK: a model that is not downloaded, or a synthesis that fails, is an
// error naming Kokoro; nothing speaks with another engine instead.

import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import {
  downloadModels,
  modelsStatus,
  type DownloadDeps,
  type DownloadProgress,
  type LocalModel,
  type ModelsStatus,
} from './local-stt-models';

export const KOKORO_MODEL: LocalModel = {
  dir: 'kokoro-int8-multi-lang-v1_0',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2',
  files: ['model.int8.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-gb-en.txt'],
  bytes: 132_353_410,
};

/**
 * The English voices, in the model's own speaker order (its `speaker_names`
 * metadata): the speaker id is the index. The other languages' voices need
 * lexicons this app does not load.
 */
export const KOKORO_VOICES: readonly string[] = [
  'af_alloy',
  'af_aoede',
  'af_bella',
  'af_heart',
  'af_jessica',
  'af_kore',
  'af_nicole',
  'af_nova',
  'af_river',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_echo',
  'am_eric',
  'am_fenrir',
  'am_liam',
  'am_michael',
  'am_onyx',
  'am_puck',
  'am_santa',
  'bf_alice',
  'bf_emma',
  'bf_isabella',
  'bf_lily',
  'bm_daniel',
  'bm_fable',
  'bm_george',
  'bm_lewis',
];
export const KOKORO_MODEL_NAME = 'kokoro-82m-v1.0';

export function kokoroStatus(modelsDir: string): ModelsStatus {
  return modelsStatus(modelsDir, [KOKORO_MODEL]);
}

export function kokoroMissingMessage(status: ModelsStatus): string {
  return `Kokoro on this computer is not downloaded (missing ${status.missing.join(', ')}). Download it in Settings → Voice calls.`;
}

const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
let tts;
try {
  const sherpa = require(workerData.sherpa);
  const d = workerData.dir + '/';
  tts = new sherpa.OfflineTts({
    model: {
      kokoro: { model: d + 'model.int8.onnx', voices: d + 'voices.bin', tokens: d + 'tokens.txt',
        lexicon: d + 'lexicon-us-en.txt,' + d + 'lexicon-gb-en.txt' },
      numThreads: 4, provider: 'cpu', debug: false,
    },
    maxNumSentences: 1,
  });
} catch (e) { parentPort.postMessage({ t: 'error', message: String(e && e.message || e) }); }
parentPort.on('message', (m) => {
  try {
    if (!tts) throw new Error('the model did not load');
    const audio = tts.generate({ text: m.text, sid: m.sid, speed: m.speed });
    if (!audio.samples || audio.samples.length === 0) throw new Error('it made no audio');
    const pcm = new Int16Array(audio.samples.length);
    for (let i = 0; i < pcm.length; i++) {
      const v = Math.max(-1, Math.min(1, audio.samples[i]));
      pcm[i] = Math.round(v * 32767);
    }
    parentPort.postMessage({ t: 'pcm', id: m.id, pcm }, [pcm.buffer]);
  } catch (e) { parentPort.postMessage({ t: 'error', id: m.id, message: String(e && e.message || e) }); }
});
`;

export interface KokoroEngine {
  synthesize(text: string, voice: string, speed: number): Promise<Int16Array>;
  close(): Promise<void>;
}

/** One worker for the app's life; the model loads once. */
export class SherpaKokoroEngine implements KokoroEngine {
  private worker: Worker | null = null;
  private nextId = 0;
  private readonly waiting = new Map<number, { ok(p: Int16Array): void; bad(e: Error): void }>();

  constructor(private readonly o: { sherpa: string; dir: string }) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(SOURCE, { eval: true, workerData: this.o });
    const failAll = (err: Error): void => {
      this.worker = null;
      for (const w of this.waiting.values()) w.bad(err);
      this.waiting.clear();
    };
    worker.on('message', (m: { t: string; id?: number; pcm?: Int16Array; message?: string }) => {
      if (m.t === 'error' && m.id === undefined) return failAll(new Error(m.message));
      if (m.id === undefined) return;
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.t === 'pcm' && m.pcm) w?.ok(m.pcm);
      else w?.bad(new Error(m.message ?? 'synthesis failed'));
    });
    worker.on('error', (err) => failAll(err));
    worker.on('exit', (code) => failAll(new Error(`Kokoro stopped (exit ${code})`)));
    this.worker = worker;
    return worker;
  }

  synthesize(text: string, voice: string, speed: number): Promise<Int16Array> {
    const sid = KOKORO_VOICES.indexOf(voice);
    if (sid < 0) return Promise.reject(new Error(`Kokoro has no voice "${voice}"`));
    const worker = this.start();
    return new Promise((ok, bad) => {
      const id = this.nextId++;
      this.waiting.set(id, { ok, bad });
      worker.postMessage({ id, text, sid, speed });
    });
  }

  async close(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
  }
}

/**
 * How often an idle Kokoro synthesises a throwaway phrase. Its weights are
 * paged out when the computer does other work, and the first call after a
 * quiet hour would otherwise wait out the whole reload before it spoke
 * (spec/07 § Latency — Kokoro kept warm). Ten minutes keeps it resident for
 * a fraction of a second of CPU each time.
 */
export const KOKORO_WARM_INTERVAL_MS = 10 * 60_000;

export class LocalTtsController {
  private engine: KokoroEngine | null = null;
  private downloading: Promise<void> | null = null;
  private lastUsed = 0;

  constructor(
    private readonly deps: {
      modelsDir: string;
      makeEngine: (dir: string) => KokoroEngine;
      download?: typeof downloadModels;
      downloadDeps?: DownloadDeps;
      now?: () => number;
    },
  ) {}

  status(): ModelsStatus & { voices: readonly string[]; model: string } {
    return {
      ...kokoroStatus(this.deps.modelsDir),
      voices: KOKORO_VOICES,
      model: KOKORO_MODEL_NAME,
    };
  }

  download(onProgress: (p: DownloadProgress) => void): Promise<void> {
    this.downloading ??= (this.deps.download ?? downloadModels)(
      this.deps.modelsDir,
      [KOKORO_MODEL],
      onProgress,
      this.deps.downloadDeps,
    ).finally(() => {
      this.downloading = null;
    });
    return this.downloading;
  }

  private ready(): KokoroEngine {
    const status = kokoroStatus(this.deps.modelsDir);
    if (!status.installed) throw new Error(kokoroMissingMessage(status));
    this.engine ??= this.deps.makeEngine(join(this.deps.modelsDir, KOKORO_MODEL.dir));
    return this.engine;
  }

  async speak(text: string, voice: string, speed: number): Promise<Int16Array> {
    this.lastUsed = (this.deps.now ?? Date.now)();
    return this.ready().synthesize(text, voice, speed);
  }

  /** Keep the model resident: at startup and while idle (KOKORO_WARM_INTERVAL_MS). */
  async warm(): Promise<void> {
    if (!kokoroStatus(this.deps.modelsDir).installed) return;
    const now = (this.deps.now ?? Date.now)();
    if (this.lastUsed !== 0 && now - this.lastUsed < KOKORO_WARM_INTERVAL_MS) return;
    this.lastUsed = now;
    await this.ready().synthesize('Ready.', KOKORO_VOICES[0]!, 1);
  }
}
