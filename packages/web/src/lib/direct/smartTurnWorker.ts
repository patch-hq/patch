// Smart Turn in a Web Worker (spec/07 § Direct calls → end of turn on the
// device): the same Whisper features the host computes (`@patch/wire/smart-turn`)
// and the same model, run by onnxruntime-web, off the page's main thread. One
// thread, so the page needs no cross-origin isolation: a check takes about
// 20 ms of features and 150 ms of model on a recent laptop, well inside the
// pause that asks it. Threads (45 ms at four) would need the whole app served
// cross-origin isolated, which breaks cross-origin popups and embeds; the
// quantised model does not run on WebGPU (DequantizeLinear rank mismatch).

import * as ort from 'onnxruntime-web/wasm';
import { N_FRAMES, N_MELS, lastEightSeconds, whisperFeatures } from '@patch/wire/smart-turn';

type In =
  | { t: 'load'; model: ArrayBuffer; wasm: { mjs: string; wasm: string } }
  | { t: 'run'; id: number; pcm: Int16Array };

let session: ort.InferenceSession | null = null;

self.onmessage = async (e: MessageEvent<In>): Promise<void> => {
  const m = e.data;
  if (m.t === 'load') {
    try {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = m.wasm;
      session = await ort.InferenceSession.create(new Uint8Array(m.model), {
        executionProviders: ['wasm'],
      });
      self.postMessage({ t: 'ready' });
    } catch (err) {
      self.postMessage({
        t: 'error',
        message: `the model would not load: ${(err as Error).message}`,
      });
    }
    return;
  }
  try {
    if (!session) throw new Error('the model is not loaded');
    const features = whisperFeatures(lastEightSeconds(m.pcm));
    const out = await session.run({
      input_features: new ort.Tensor('float32', features, [1, N_MELS, N_FRAMES]),
    });
    const p = (Object.values(out)[0]?.data as Float32Array | undefined)?.[0];
    if (typeof p !== 'number' || !Number.isFinite(p))
      throw new Error('the model returned no probability');
    self.postMessage({ t: 'p', id: m.id, p: Math.min(1, Math.max(0, p)) });
  } catch (err) {
    self.postMessage({ t: 'error', id: m.id, message: (err as Error).message });
  }
};
