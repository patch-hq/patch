// The models meeting transcription runs on this device: Parakeet TDT v3 (int8)
// and the Silero voice-activity detector. They are too big to ship inside the
// app (about 670 MB), so the first meeting downloads them into the app's data
// directory, with progress, and every later meeting uses that copy.
//
// No electron import, so the replay tool can share it. NO FALLBACK: a failed
// download or extraction is an error naming what failed, and a meeting does not
// start without the models.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { missingModelFiles } from './meeting-transcriber';

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
export const PARAKEET_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
const PARAKEET_URL = `${RELEASES}/${PARAKEET_NAME}.tar.bz2`;
const VAD_URL = `${RELEASES}/silero_vad.onnx`;

export interface MeetingModelPaths {
  dir: string;
  parakeetDir: string;
  vadModel: string;
}

/** Where the models live. `base` is the app's data dir; without one, the same place Electron would use. */
export function meetingModelPaths(base?: string): MeetingModelPaths {
  const dataDir =
    base ??
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Patch')
      : join(homedir(), '.config', 'Patch'));
  const dir = join(dataDir, 'models');
  return { dir, parakeetDir: join(dir, PARAKEET_NAME), vadModel: join(dir, 'silero_vad.onnx') };
}

export function meetingModelsReady(p: MeetingModelPaths): boolean {
  return missingModelFiles(p.parakeetDir, p.vadModel).length === 0;
}

export interface ModelProgress {
  /** Bytes downloaded so far across both files, and the total once known. */
  received: number;
  total: number | null;
  phase: 'downloading' | 'unpacking';
}

async function download(
  url: string,
  to: string,
  onBytes: (n: number, total: number | null) => void,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Downloading ${url} failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || null;
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('data', (chunk: Buffer) => onBytes(chunk.length, total));
  const part = `${to}.part`;
  await pipeline(body, createWriteStream(part));
  renameSync(part, to);
}

function untar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['xjf', archive, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (b: Buffer) => (err += b.toString()));
    p.on('error', (e) => reject(new Error(`Unpacking the speech model failed: ${e.message}`)));
    p.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Unpacking the speech model failed (tar exit ${code}): ${err.trim()}`)),
    );
  });
}

let inFlight: Promise<void> | null = null;

/** Download whatever is missing. Concurrent callers share one download. */
export function ensureMeetingModels(
  p: MeetingModelPaths,
  onProgress: (e: ModelProgress) => void = () => undefined,
): Promise<void> {
  if (meetingModelsReady(p)) return Promise.resolve();
  inFlight ??= (async () => {
    mkdirSync(p.dir, { recursive: true });
    let received = 0;
    let total: number | null = null;
    const bytes = (n: number, t: number | null): void => {
      received += n;
      if (t !== null && total === null) total = t;
      onProgress({ received, total, phase: 'downloading' });
    };
    if (!existsSync(p.vadModel)) await download(VAD_URL, p.vadModel, bytes);
    if (missingModelFiles(p.parakeetDir, p.vadModel).length > 0) {
      const archive = join(p.dir, `${PARAKEET_NAME}.tar.bz2`);
      total = null;
      await download(PARAKEET_URL, archive, bytes);
      onProgress({ received, total, phase: 'unpacking' });
      rmSync(p.parakeetDir, { recursive: true, force: true });
      await untar(archive, p.dir);
      rmSync(archive, { force: true });
      rmSync(join(p.parakeetDir, 'test_wavs'), { recursive: true, force: true });
    }
    const missing = missingModelFiles(p.parakeetDir, p.vadModel);
    if (missing.length > 0) {
      throw new Error(`The speech model downloaded but is incomplete: ${missing.join(', ')}`);
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
