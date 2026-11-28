// Pause (spec/07 § Pause): a soft hang-up that leaves the call on the bar, the
// silence timeout, headphones out/in, and the reason an agent rang opening the call.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { playCallSound } from '../lib/callSound.js';
vi.mock('../lib/callSound.js', () => ({ playCallSound: vi.fn(), syncCallSoundLoop: vi.fn() }));

import {
  __setAudioOpenerForTests,
  startVoiceCall,
  endVoiceCall,
  pauseVoiceCall,
  resumeVoiceCall,
  setCallMode,
} from '../lib/voiceController.js';
import { watchCallHeadphones } from '../lib/callHeadphones.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import type {
  AudioSession,
  AudioSessionCallbacks,
  OpenAudioSessionOpts,
} from '../lib/audioSession.js';

interface Opened {
  opts: OpenAudioSessionOpts;
  callbacks: AudioSessionCallbacks;
  end: ReturnType<typeof vi.fn>;
}
let opened: Opened[] = [];

/**
 * A host that answers the session at once and then keeps the line alive with a
 * heartbeat every second until the session is ended, as a real one does.
 */
function stubOpener(opts: OpenAudioSessionOpts): Promise<AudioSession> {
  const sessionId = `sess-${opened.length + 1}`;
  let n = 0;
  const beat = setInterval(
    () => opts.callbacks.onHeartbeat?.({ type: 'audio.heartbeat', sessionId, n: n++ }),
    1_000,
  );
  const end = vi.fn(() => clearInterval(beat));
  opened.push({ opts, callbacks: opts.callbacks, end });
  void Promise.resolve().then(() => opts.callbacks.onState?.('listening', sessionId));
  return Promise.resolve({
    sessionId,
    chatId: opts.chatId,
    setMuted: () => {},
    finishDictation: () => {},
    isMuted: () => false,
    send: () => true,
    setSessionMode: () => {},
    speak: () => {},
    sendPcm: () => {},
    end,
  });
}

const sound = vi.mocked(playCallSound);
const last = (): Opened => opened[opened.length - 1]!;

function quietAfter(minutes: 0 | 2 | 5 | 10 | 30): void {
  usePreferencesStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, pauseWhenQuietMinutes: minutes },
    loaded: true,
  });
}

describe('pausing a call', () => {
  beforeEach(() => {
    opened = [];
    sound.mockClear();
    useVoiceStore.setState({ call: null, session: null, incomingCall: null });
    quietAfter(0);
    __setAudioOpenerForTests(stubOpener);
  });
  afterEach(() => {
    endVoiceCall({ silent: true });
    __setAudioOpenerForTests(null);
    vi.useRealTimers();
  });

  it('closes the session but keeps the call on the bar, with the paused sound', async () => {
    await startVoiceCall('c1');
    pauseVoiceCall();
    const s = useVoiceStore.getState();
    expect(s.call?.paused).toBe('button');
    expect(s.call?.chatId).toBe('c1');
    expect(s.session).toBeNull();
    expect(last().end).toHaveBeenCalledWith('paused');
    expect(sound).toHaveBeenLastCalledWith('paused');
  });

  it('the paused session closing is not taken for a drop: nothing redials', async () => {
    vi.useFakeTimers();
    await startVoiceCall('c1');
    pauseVoiceCall();
    last().callbacks.onClose('paused');
    last().callbacks.onError('host_unreachable: gone');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opened).toHaveLength(1);
    expect(useVoiceStore.getState().call?.paused).toBe('button');
  });

  it('resume opens a fresh session on the same chat — not a redial — and plays connected', async () => {
    await startVoiceCall('c1', 'hands-free');
    pauseVoiceCall();
    sound.mockClear();
    await resumeVoiceCall();
    expect(opened).toHaveLength(2);
    expect(last().opts.chatId).toBe('c1');
    expect(last().opts.mode).toBe('hands-free');
    expect(last().opts.resumes).toBeUndefined();
    expect(useVoiceStore.getState().call?.paused).toBeNull();
    expect(useVoiceStore.getState().session).not.toBeNull();
    expect(sound).toHaveBeenLastCalledWith('connected');
  });

  it('ending a paused call hangs up with the ended sound', async () => {
    await startVoiceCall('c1');
    pauseVoiceCall();
    endVoiceCall();
    expect(useVoiceStore.getState().call).toBeNull();
    expect(sound).toHaveBeenLastCalledWith('ended');
  });

  it("a new call (an agent's, accepted) replaces a paused one", async () => {
    await startVoiceCall('c1');
    pauseVoiceCall();
    await startVoiceCall('c2', 'call', undefined, { callReason: 'Need a decision' });
    expect(useVoiceStore.getState().call?.chatId).toBe('c2');
    expect(useVoiceStore.getState().call?.paused).toBeNull();
    expect(last().opts.callReason).toBe('Need a decision');
  });

  it('a redial does not carry the reason the agent rang again', async () => {
    vi.useFakeTimers();
    await startVoiceCall('c1', 'call', undefined, { callReason: 'Need a decision' });
    last().callbacks.onClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opened).toHaveLength(2);
    expect(last().opts.resumes).toEqual(expect.any(String));
    expect(last().opts.callReason).toBeUndefined();
  });
});

describe('pause when quiet', () => {
  beforeEach(() => {
    opened = [];
    sound.mockClear();
    useVoiceStore.setState({ call: null, session: null });
    __setAudioOpenerForTests(stubOpener);
    vi.useFakeTimers();
  });
  afterEach(() => {
    endVoiceCall({ silent: true });
    __setAudioOpenerForTests(null);
    vi.useRealTimers();
  });

  it('pauses a call after the set time with nothing said', async () => {
    quietAfter(2);
    await startVoiceCall('c1');
    await vi.advanceTimersByTimeAsync(2 * 60_000 - 1);
    expect(useVoiceStore.getState().call?.paused).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(useVoiceStore.getState().call?.paused).toBe('quiet');
  });

  it('anything said by either side starts the clock again', async () => {
    quietAfter(2);
    await startVoiceCall('c1');
    await vi.advanceTimersByTimeAsync(90_000);
    last().callbacks.onTranscriptPartial('so what about');
    await vi.advanceTimersByTimeAsync(90_000);
    last().callbacks.onTtsStart();
    last().callbacks.onTtsEnd(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(useVoiceStore.getState().call?.paused).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(useVoiceStore.getState().call?.paused).toBe('quiet');
  });

  it('a reply still playing is not silence', async () => {
    quietAfter(2);
    await startVoiceCall('c1');
    last().callbacks.onTtsStart();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(useVoiceStore.getState().call?.paused).toBeNull();
  });

  it('is off by default', async () => {
    quietAfter(0);
    await startVoiceCall('c1');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(useVoiceStore.getState().call?.paused).toBeNull();
  });

  it('leaves hands-free alone: it is a line left open on purpose', async () => {
    quietAfter(2);
    await startVoiceCall('c1');
    setCallMode('hands-free');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(useVoiceStore.getState().call?.paused).toBeNull();
  });

  it('does not resume by itself', async () => {
    quietAfter(2);
    await startVoiceCall('c1');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(opened).toHaveLength(1);
  });
});

describe('headphones out and back in', () => {
  type Device = { kind: MediaDeviceKind; deviceId: string; groupId: string };
  function fakeDevices(initial: Device[]) {
    let devices = initial;
    const listeners = new Set<() => void>();
    return {
      set(next: Device[]) {
        devices = next;
        for (const l of listeners) l();
      },
      mediaDevices: {
        enumerateDevices: async () => devices as unknown as MediaDeviceInfo[],
        addEventListener: (_: string, l: () => void) => listeners.add(l),
        removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      } as unknown as Pick<
        MediaDevices,
        'enumerateDevices' | 'addEventListener' | 'removeEventListener'
      >,
    };
  }
  const speakers: Device = { kind: 'audiooutput', deviceId: 'spk', groupId: 'g-speakers' };
  const headphonesDefault: Device = {
    kind: 'audiooutput',
    deviceId: 'default',
    groupId: 'g-headphones',
  };
  const headphones: Device = { kind: 'audiooutput', deviceId: 'hp', groupId: 'g-headphones' };
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('reports the call’s output device going and the same one coming back', async () => {
    const d = fakeDevices([headphonesDefault, headphones, speakers]);
    const onGone = vi.fn();
    const onBack = vi.fn();
    const stop = watchCallHeadphones({ mediaDevices: d.mediaDevices, onGone, onBack });
    await flush();
    d.set([{ ...speakers, deviceId: 'default' }, speakers]);
    await flush();
    expect(onGone).toHaveBeenCalledTimes(1);
    d.set([headphonesDefault, headphones, speakers]);
    await flush();
    expect(onBack).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a call on built-in speakers is not paused by another device coming and going', async () => {
    const d = fakeDevices([{ ...speakers, deviceId: 'default' }, speakers]);
    const onGone = vi.fn();
    const stop = watchCallHeadphones({ mediaDevices: d.mediaDevices, onGone, onBack: vi.fn() });
    await flush();
    d.set([{ ...speakers, deviceId: 'default' }, speakers, headphones]);
    d.set([{ ...speakers, deviceId: 'default' }, speakers]);
    await flush();
    expect(onGone).not.toHaveBeenCalled();
    stop();
  });

  it('pauses the call when they come out and resumes it when they go back in', async () => {
    const d = fakeDevices([headphonesDefault, headphones, speakers]);
    const real = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: d.mediaDevices,
      configurable: true,
    });
    opened = [];
    __setAudioOpenerForTests(stubOpener);
    useVoiceStore.setState({ call: null, session: null });
    try {
      await startVoiceCall('c1');
      await flush();
      d.set([{ ...speakers, deviceId: 'default' }, speakers]);
      await flush();
      expect(useVoiceStore.getState().call?.paused).toBe('headphones');
      d.set([headphonesDefault, headphones, speakers]);
      await flush();
      await flush();
      expect(useVoiceStore.getState().call?.paused).toBeNull();
      expect(opened).toHaveLength(2);
    } finally {
      endVoiceCall({ silent: true });
      __setAudioOpenerForTests(null);
      Object.defineProperty(navigator, 'mediaDevices', { value: real, configurable: true });
    }
  });

  it('a call paused from the button does not resume when headphones go in', async () => {
    const d = fakeDevices([headphonesDefault, headphones, speakers]);
    const real = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: d.mediaDevices,
      configurable: true,
    });
    opened = [];
    __setAudioOpenerForTests(stubOpener);
    useVoiceStore.setState({ call: null, session: null });
    try {
      await startVoiceCall('c1');
      await flush();
      pauseVoiceCall();
      d.set([{ ...speakers, deviceId: 'default' }, speakers]);
      await flush();
      d.set([headphonesDefault, headphones, speakers]);
      await flush();
      expect(useVoiceStore.getState().call?.paused).toBe('button');
      expect(opened).toHaveLength(1);
    } finally {
      endVoiceCall({ silent: true });
      __setAudioOpenerForTests(null);
      Object.defineProperty(navigator, 'mediaDevices', { value: real, configurable: true });
    }
  });
});
