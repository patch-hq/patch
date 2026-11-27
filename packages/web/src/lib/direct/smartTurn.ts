// Smart Turn on this device, for a direct call (spec/07 § Direct calls). The
// model is the one the Patch server serves with this app (`SMART_TURN_MODEL`),
// checked against its pinned checksum before it is loaded. Loaded once per page.
//
// NO FALLBACK: a model that is missing, does not match, or will not load fails
// the turn check with the reason; the long pause then ends the utterance.

import type { DirectTurnDetector } from '@patch/wire/direct-call-runtime';
import { SMART_TURN_MODEL } from '@patch/wire/smart-turn';
import wasmMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import wasmBin from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

export const SMART_TURN_LABEL = 'Smart Turn';

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The model's bytes, checked. */
export async function fetchSmartTurnModel(fetchImpl: typeof fetch = fetch): Promise<ArrayBuffer> {
  const res = await fetchImpl(SMART_TURN_MODEL.path);
  if (!res.ok) {
    throw new Error(
      `the server has no Smart Turn model (${SMART_TURN_MODEL.path}: HTTP ${res.status})`,
    );
  }
  const bytes = await res.arrayBuffer();
  if ((await sha256Hex(bytes)) !== SMART_TURN_MODEL.sha256) {
    throw new Error(`the server's Smart Turn model does not match its pinned checksum`);
  }
  return bytes;
}

function startWorker(model: ArrayBuffer): Promise<DirectTurnDetector> {
  const worker = new Worker(new URL('./smartTurnWorker.ts', import.meta.url), { type: 'module' });
  const waiting = new Map<number, { ok(p: number): void; bad(e: Error): void }>();
  let nextId = 0;
  return new Promise((resolve, reject) => {
    let ready = false;
    worker.onmessage = (
      e: MessageEvent<{ t: string; id?: number; p?: number; message?: string }>,
    ) => {
      const m = e.data;
      if (m.t === 'ready') {
        ready = true;
        resolve({
          label: SMART_TURN_LABEL,
          probability(pcm) {
            return new Promise((ok, bad) => {
              const id = nextId++;
              waiting.set(id, { ok, bad });
              worker.postMessage({ t: 'run', id, pcm });
            });
          },
        });
        return;
      }
      if (m.t === 'error' && m.id === undefined) {
        const err = new Error(m.message);
        if (!ready) reject(err);
        for (const w of waiting.values()) w.bad(err);
        waiting.clear();
        return;
      }
      const w = m.id !== undefined ? waiting.get(m.id) : undefined;
      if (!w) return;
      waiting.delete(m.id!);
      if (m.t === 'p' && m.p !== undefined) w.ok(m.p);
      else w.bad(new Error(m.message ?? 'the turn check failed'));
    };
    worker.onerror = (e) => {
      const err = new Error(`the Smart Turn worker stopped: ${e.message}`);
      if (!ready) reject(err);
      for (const w of waiting.values()) w.bad(err);
      waiting.clear();
    };
    worker.postMessage({ t: 'load', model, wasm: { mjs: wasmMjs, wasm: wasmBin } }, [model]);
  });
}

let loading: Promise<DirectTurnDetector> | null = null;

/** The page's one Smart Turn detector; a failed load is retried on the next call. */
export function loadSmartTurn(): Promise<DirectTurnDetector> {
  loading ??= fetchSmartTurnModel()
    .then(startWorker)
    .catch((err: Error) => {
      loading = null;
      throw err;
    });
  return loading;
}
