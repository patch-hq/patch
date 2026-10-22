// Desktop shell: Chromium's async clipboard rejects image writes in the packaged
// app, so the PNG goes through the shell's native clipboard bridge instead.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { copyImageToClipboard } from '../lib/copyImage.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { patch?: unknown }).patch;
});

const png = (): unknown => ({
  ok: true,
  blob: async () => ({
    type: 'image/png',
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  }),
});

describe('copyImageToClipboard', () => {
  it('hands the PNG bytes to the desktop bridge, not navigator.clipboard', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(png()));
    const write = vi.fn();
    Object.assign(navigator, { clipboard: { write } });
    const copyImagePng = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { patch: unknown }).patch = { copyImagePng };
    await copyImageToClipboard('/a.png');
    expect(copyImagePng).toHaveBeenCalledOnce();
    expect(Array.from(copyImagePng.mock.calls[0]![0] as Uint8Array)).toEqual([1, 2, 3]);
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects when the bridge write fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(png()));
    (window as unknown as { patch: unknown }).patch = {
      copyImagePng: vi.fn().mockRejectedValue(new Error('boom')),
    };
    await expect(copyImageToClipboard('/a.png')).rejects.toThrow('boom');
  });
});
