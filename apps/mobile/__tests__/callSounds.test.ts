// lib/callSounds.ts — the call's own sounds (spec/07 § Call sounds), played by
// the native PatchCallSounds module as call signalling that takes no audio
// focus, so the call taking its own focus cannot stop them.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Image, NativeModules, Platform } from 'react-native';

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

const native = {
  play: vi.fn(async (_uri: string) => undefined),
  startLoop: vi.fn(async (_name: string, _uri: string) => undefined),
  stopLoop: vi.fn(async (_name: string) => undefined),
};

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('call sounds', () => {
  beforeEach(async () => {
    Platform.OS = 'android';
    NativeModules['PatchCallSounds'] = native;
    // Metro's asset ids resolve to the bundled file: here, a raw resource name.
    (
      Image as unknown as { resolveAssetSource: (id: number) => { uri: string } }
    ).resolveAssetSource = (id) => ({ uri: `call_sound_${id}` });
    for (const name of playingCallSoundLoops()) await stopCallSoundLoop(name);
    vi.clearAllMocks();
    useUiStore.setState({ errors: [] });
  });

  it('plays a one-off sound from its own bundled file', async () => {
    await playCallSound('reconnected');
    expect(native.play).toHaveBeenCalledWith('call_sound_5');
  });

  it('a sound that cannot play says so', async () => {
    native.play.mockRejectedValueOnce(new Error('no output'));
    await playCallSound('ended');
    expect(useUiStore.getState().errors[0]?.message).toContain('ended sound failed: no output');
  });

  it('loops a looping sound once, however often it is started, until it is stopped', async () => {
    await startCallSoundLoop('reconnecting');
    await startCallSoundLoop('reconnecting');
    expect(native.startLoop).toHaveBeenCalledTimes(1);
    expect(native.startLoop).toHaveBeenCalledWith('reconnecting', 'call_sound_4');
    expect(playingCallSoundLoops()).toEqual(['reconnecting']);
    await stopCallSoundLoop('reconnecting');
    expect(native.stopLoop).toHaveBeenCalledWith('reconnecting');
    expect(playingCallSoundLoops()).toEqual([]);
    await stopCallSoundLoop('reconnecting');
    expect(native.stopLoop).toHaveBeenCalledTimes(1);
  });

  it('a loop stopped while it is still starting is stopped natively after its start', async () => {
    syncCallSoundLoop('connecting', true);
    syncCallSoundLoop('connecting', false);
    await flush();
    expect(native.startLoop.mock.invocationCallOrder[0]!).toBeLessThan(
      native.stopLoop.mock.invocationCallOrder[0]!,
    );
    expect(playingCallSoundLoops()).toEqual([]);
  });

  it('a loop that cannot start says so and can be started again', async () => {
    native.startLoop.mockRejectedValueOnce(new Error('busy'));
    await startCallSoundLoop('agent-calling');
    expect(useUiStore.getState().errors[0]?.message).toContain('agent-calling sound failed: busy');
    expect(playingCallSoundLoops()).toEqual([]);
    await startCallSoundLoop('agent-calling');
    expect(playingCallSoundLoops()).toEqual(['agent-calling']);
  });

  it('a failed start after the loop was replaced leaves the new one alone', async () => {
    let reject: (e: Error) => void = () => undefined;
    native.startLoop.mockImplementationOnce(
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
    native.stopLoop.mockRejectedValueOnce(new Error('gone'));
    await stopCallSoundLoop('connecting');
    expect(useUiStore.getState().errors[0]?.message).toContain(
      'stopping the connecting sound failed: gone',
    );
  });

  it('there are no call sounds without the native module (NO FALLBACK)', async () => {
    delete NativeModules['PatchCallSounds'];
    await playCallSound('connected');
    expect(useUiStore.getState().errors[0]?.message).toContain(
      'PatchCallSounds native module missing',
    );
  });
});
