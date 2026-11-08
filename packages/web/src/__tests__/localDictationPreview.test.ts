import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_ENGINE_DESKTOP_ONLY,
  startLocalDictationPreview,
} from '../lib/localDictationPreview.js';

type Ev = { type: 'partial'; text: string } | { type: 'error'; message: string };

function bridge(
  over: Partial<{ start: () => Promise<() => void>; finish: () => Promise<string> }> = {},
) {
  let emit: (ev: Ev) => void = () => undefined;
  const stt = {
    status: vi.fn(),
    download: vi.fn(),
    start: vi.fn(async (cb: (ev: Ev) => void) => {
      emit = cb;
      return () => undefined;
    }),
    push: vi.fn(),
    finish: vi.fn(async () => 'Hello there.'),
    cancel: vi.fn(),
    ...over,
  };
  (window as unknown as { patch: unknown }).patch = { localStt: stt };
  return { stt, emit: (ev: Ev) => emit(ev) };
}

afterEach(() => {
  delete (window as unknown as { patch?: unknown }).patch;
  vi.restoreAllMocks();
});

describe('startLocalDictationPreview', () => {
  it('feeds the microphone to the desktop app and returns its words', async () => {
    const { stt, emit } = bridge();
    const onPartial = vi.fn();
    const p = startLocalDictationPreview('c1', { onPartial, onPreviewError: vi.fn() });
    p.push(Int16Array.from([1, 2]));
    await vi.waitFor(() => expect(stt.push).toHaveBeenCalledTimes(1));
    emit({ type: 'partial', text: 'hello th' });
    expect(onPartial).toHaveBeenCalledWith('hello th');
    await expect(p.finish()).resolves.toBe('Hello there.');
  });

  it('outside the desktop app it says so and the dictation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onPreviewError = vi.fn();
    const p = startLocalDictationPreview('c1', { onPartial: vi.fn(), onPreviewError });
    expect(onPreviewError).toHaveBeenCalledWith(LOCAL_ENGINE_DESKTOP_ONLY);
    await expect(p.finish()).rejects.toThrow(/desktop app/);
  });

  it('models that are not downloaded are reported and fail the dictation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bridge({
      start: async () => Promise.reject(new Error('Parakeet on this computer is not downloaded')),
    });
    const onPreviewError = vi.fn();
    const p = startLocalDictationPreview('c1', { onPartial: vi.fn(), onPreviewError });
    await expect(p.finish()).rejects.toThrow(/not downloaded/);
    expect(onPreviewError).toHaveBeenCalledWith(expect.stringContaining('not downloaded'));
  });

  it('stopping cancels the desktop dictation', async () => {
    const { stt } = bridge();
    const p = startLocalDictationPreview('c1', { onPartial: vi.fn(), onPreviewError: vi.fn() });
    await vi.waitFor(() => expect(stt.start).toHaveBeenCalled());
    p.stop();
    expect(stt.cancel).toHaveBeenCalled();
  });
});
