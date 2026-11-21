import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAsync, sound } = vi.hoisted(() => {
  const sound = {
    stopAsync: vi.fn(async () => undefined),
    unloadAsync: vi.fn(async () => undefined),
  };
  return { sound, createAsync: vi.fn(async () => ({ sound })) };
});
vi.mock('expo-av', () => ({ Audio: { Sound: { createAsync } } }));
vi.mock('../src/lib/voiceRingbackAsset', () => ({ ringbackAsset: 1 }));

import { startRingback, stopRingback } from '../src/lib/voiceRingback';

describe('ringback', () => {
  beforeEach(async () => {
    await stopRingback();
    vi.clearAllMocks();
  });

  it('loops the tone and stops it', async () => {
    await startRingback();
    expect(createAsync).toHaveBeenCalledWith(expect.anything(), {
      shouldPlay: true,
      isLooping: true,
    });
    await stopRingback();
    expect(sound.stopAsync).toHaveBeenCalled();
    expect(sound.unloadAsync).toHaveBeenCalled();
  });

  it('does not start twice', async () => {
    await startRingback();
    await startRingback();
    expect(createAsync).toHaveBeenCalledTimes(1);
  });
});
