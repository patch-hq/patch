import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAsync, sounds } = vi.hoisted(() => {
  const sounds: Array<{
    stopAsync: ReturnType<typeof vi.fn>;
    unloadAsync: ReturnType<typeof vi.fn>;
    setOnPlaybackStatusUpdate: ReturnType<typeof vi.fn>;
  }> = [];
  const createAsync = vi.fn(async (_asset: number, _opts: object) => {
    const sound = {
      stopAsync: vi.fn(async () => undefined),
      unloadAsync: vi.fn(async () => undefined),
      setOnPlaybackStatusUpdate: vi.fn(),
    };
    sounds.push(sound);
    return { sound };
  });
  return { createAsync, sounds };
});
vi.mock('expo-av', () => ({ Audio: { Sound: { createAsync } } }));
vi.mock('../src/lib/callSoundAssets', () => ({
  CALL_SOUND_ASSETS: {
    connecting: 1,
    connected: 2,
    'passed-to-agent': 3,
    reconnecting: 4,
    reconnected: 5,
    paused: 6,
    ended: 7,
    'agent-calling': 8,
    'agent-working': 9,
    failed: 10,
  },
}));

import {
  playCallSound,
  playingCallSoundLoops,
  startCallSoundLoop,
  stopCallSoundLoop,
  syncCallSoundLoop,
} from '../src/lib/callSounds';
import { useUiStore } from '../src/stores/uiStore';

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('call sounds', () => {
  beforeEach(async () => {
    for (const name of playingCallSoundLoops()) await stopCallSoundLoop(name);
    vi.clearAllMocks();
    sounds.length = 0;
    useUiStore.setState({ errors: [] });
  });

  it('plays a one-off sound from its own file and unloads it when it finishes', async () => {
    await playCallSound('reconnected');
    expect(createAsync).toHaveBeenCalledWith(5, { shouldPlay: true });
    const onStatus = sounds[0]!.setOnPlaybackStatusUpdate.mock.calls[0]![0] as (s: object) => void;
    onStatus({ isLoaded: true, didJustFinish: false });
    expect(sounds[0]!.unloadAsync).not.toHaveBeenCalled();
    onStatus({ isLoaded: true, didJustFinish: true });
    expect(sounds[0]!.unloadAsync).toHaveBeenCalled();
  });

  it('a sound that cannot play says so', async () => {
    createAsync.mockRejectedValueOnce(new Error('no output'));
    await playCallSound('ended');
    expect(useUiStore.getState().errors[0]?.message).toContain('ended sound failed: no output');
  });

  it('loops a looping sound once, however often it is started, until it is stopped', async () => {
    await startCallSoundLoop('reconnecting');
    await startCallSoundLoop('reconnecting');
    expect(createAsync).toHaveBeenCalledTimes(1);
    expect(createAsync).toHaveBeenCalledWith(4, { shouldPlay: true, isLooping: true });
    expect(playingCallSoundLoops()).toEqual(['reconnecting']);
    await stopCallSoundLoop('reconnecting');
    expect(sounds[0]!.stopAsync).toHaveBeenCalled();
    expect(sounds[0]!.unloadAsync).toHaveBeenCalled();
    expect(playingCallSoundLoops()).toEqual([]);
    await stopCallSoundLoop('reconnecting');
  });

  it('a loop stopped while it is still loading never plays on', async () => {
    syncCallSoundLoop('connecting', true);
    syncCallSoundLoop('connecting', false);
    await flush();
    expect(sounds[0]!.unloadAsync).toHaveBeenCalled();
    expect(sounds[0]!.stopAsync).not.toHaveBeenCalled();
  });

  it('a loop that cannot start says so and can be started again', async () => {
    createAsync.mockRejectedValueOnce(new Error('busy'));
    await startCallSoundLoop('agent-calling');
    expect(useUiStore.getState().errors[0]?.message).toContain('agent-calling sound failed: busy');
    expect(playingCallSoundLoops()).toEqual([]);
    await startCallSoundLoop('agent-calling');
    expect(playingCallSoundLoops()).toEqual(['agent-calling']);
  });

  it('a failed load after the loop was replaced leaves the new one alone', async () => {
    let reject: (e: Error) => void = () => undefined;
    createAsync.mockImplementationOnce(
      () => new Promise((_res, rej) => (reject = rej as (e: Error) => void)),
    );
    const first = startCallSoundLoop('agent-working');
    await stopCallSoundLoop('agent-working');
    await startCallSoundLoop('agent-working');
    reject(new Error('late'));
    await first;
    expect(playingCallSoundLoops()).toEqual(['agent-working']);
  });

  it('a loop that will not stop says so', async () => {
    await startCallSoundLoop('connecting');
    sounds[0]!.stopAsync.mockRejectedValueOnce(new Error('gone'));
    await stopCallSoundLoop('connecting');
    expect(useUiStore.getState().errors[0]?.message).toContain(
      'stopping the connecting sound failed: gone',
    );
  });
});
