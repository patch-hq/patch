// The Parakeet models "Parakeet on this computer" dictation runs (spec/07 §
// Dictation engines, `local`). The desktop app keeps its own copy, in its own
// user-data folder, downloaded on demand like a host component: the host's
// models are on the host's disk and a dictation here must not depend on them.
//
// NO FALLBACK: a model that is absent, half-downloaded or fails to unpack is an
// error naming what is missing; nothing falls back to the host's engine.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

export interface LocalSttModel {
  /** Folder name, inside the models directory, once unpacked. */
  dir: string;
  url: string;
  /** What a model folder must hold to be loaded. */
  files: readonly string[];
  /** Download size, for the prompt that offers it. */
  bytes: number;
  /** What it does in a dictation. */
  role: 'live' | 'accurate';
}

const FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'] as const;

export const LOCAL_STT_MODELS: readonly LocalSttModel[] = [
  {
    dir: 'sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8',
    url: `${RELEASES}/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8.tar.bz2`,
    files: FILES,
    bytes: 105_913_204,
    role: 'live',
  },
  {
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    url: `${RELEASES}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    files: FILES,
    bytes: 487_211_443,
    role: 'accurate',
  },
];

export function modelDir(modelsDir: string, role: LocalSttModel['role']): string {
  const m = LOCAL_STT_MODELS.find((x) => x.role === role)!;
  return join(modelsDir, m.dir);
}

export interface LocalSttStatus {
  installed: boolean;
  /** Files absent from the models folder, as `<model dir>/<file>`. */
  missing: string[];
  /** Total download size when something is missing. */
  downloadBytes: number;
}

export function localSttStatus(modelsDir: string): LocalSttStatus {
  const missing: string[] = [];
  let downloadBytes = 0;
  for (const m of LOCAL_STT_MODELS) {
    const gone = m.files.filter((f) => !existsSync(join(modelsDir, m.dir, f)));
    if (gone.length > 0) downloadBytes += m.bytes;
    for (const f of gone) missing.push(`${m.dir}/${f}`);
  }
  return { installed: missing.length === 0, missing, downloadBytes };
}

/** The message every surface shows for a dictation that cannot start. */
export function localSttMissingMessage(status: LocalSttStatus): string {
  return `Parakeet on this computer is not downloaded (missing ${status.missing.join(', ')}). Download it in Settings → Voice.`;
}

export interface DownloadProgress {
  received: number;
  total: number;
}

export interface DownloadDeps {
  fetchImpl?: typeof fetch;
  /** Unpack a `.tar.bz2` into a directory. */
  extract?: (archive: string, into: string) => Promise<void>;
}

export function extractTarBz2(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xjf', archive, '-C', into], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', (b: Buffer) => (err += b.toString()));
    proc.on('error', (e) =>
      reject(new Error(`could not run tar to unpack the model: ${e.message}`)),
    );
    proc.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`tar could not unpack the model (exit ${code}): ${err.trim()}`)),
    );
  });
}

/**
 * Download and unpack every model that is not complete. Each lands in a
 * scratch folder and is moved into place only once it holds every file, so an
 * interrupted download never leaves a folder that looks installed.
 */
export async function downloadLocalSttModels(
  modelsDir: string,
  onProgress: (p: DownloadProgress) => void,
  deps: DownloadDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const extract = deps.extract ?? extractTarBz2;
  mkdirSync(modelsDir, { recursive: true });
  const todo = LOCAL_STT_MODELS.filter((m) =>
    m.files.some((f) => !existsSync(join(modelsDir, m.dir, f))),
  );
  const total = todo.reduce((n, m) => n + m.bytes, 0);
  let done = 0;
  for (const m of todo) {
    const scratch = join(modelsDir, `.download-${m.dir}`);
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    try {
      const res = await fetchImpl(m.url);
      if (!res.ok || !res.body) throw new Error(`GET ${m.url} → HTTP ${res.status}`);
      const archive = join(scratch, 'model.tar.bz2');
      let received = 0;
      const body = Readable.fromWeb(res.body as never);
      body.on('data', (c: Buffer) => {
        received += c.length;
        onProgress({ received: done + received, total });
      });
      await pipeline(body, createWriteStream(archive));
      await extract(archive, scratch);
      const unpacked = join(scratch, m.dir);
      const gone = m.files.filter((f) => !existsSync(join(unpacked, f)));
      if (gone.length > 0) throw new Error(`${m.url} did not hold ${gone.join(', ')}`);
      rmSync(join(modelsDir, m.dir), { recursive: true, force: true });
      renameSync(unpacked, join(modelsDir, m.dir));
      done += m.bytes;
      onProgress({ received: done, total });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
