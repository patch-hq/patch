import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  syncCallSoundLoop,
  __resetCallSoundForTests,
  playCallSound,
  playingCallSoundLoops,
  startCallSoundLoop,
  stopCallSoundLoop,
  warmCallSounds,
} from '../lib/callSound.js';
import { CALL_SOUNDS, CALL_SOUND_NAMES } from '../lib/callSoundSynth.js';

// A recording stand-in for WebAudio: enough of the node graph to see which
// notes a sound schedules and when.
function fakeAudio() {
  const notes: Array<{ hz: number; type: string; at: number }> = [];
  const renders = { count: 0 };
  const sources: Array<{
    loop: boolean;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  });
  class Base {
    currentTime = 0;
    sampleRate = 22050;
    state = 'running';
    destination = {};
    createGain() {
      return { gain: param(), connect: (n: unknown) => n };
    }
    createOscillator() {
      const o = {
        type: 'sine',
        frequency: {
          ...param(),
          setValueAtTime: (hz: number) => {
            o._hz = hz;
          },
        },
        _hz: 0,
        connect: (n: unknown) => n,
        start: (at: number) => notes.push({ hz: o._hz, type: o.type, at }),
        stop: vi.fn(),
      };
      return o;
    }
  }
  class FakeCtx extends Base {
    resume = vi.fn(async () => undefined);
    createBufferSource() {
      const s = { buffer: null, loop: false, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      sources.push(s);
      return s;
    }
  }
  class FakeOffline extends Base {
    constructor(
      _ch: number,
      public length: number,
      sr: number,
    ) {
      super();
      this.sampleRate = sr;
    }
    startRendering() {
      renders.count++;
      return Promise.resolve({ length: this.length } as unknown as AudioBuffer);
    }
  }
  return {
    FakeCtx,
    FakeOffline,
    notes,
    sources,
    get renders() {
      return renders.count;
    },
  };
}

describe('call sounds', () => {
  afterEach(() => {
    __resetCallSoundForTests();
    vi.unstubAllGlobals();
  });

  it('plays each sound from a buffer rendered once at the output rate', async () => {
    const a = fakeAudio();
    vi.stubGlobal('AudioContext', a.FakeCtx);
    vi.stubGlobal('OfflineAudioContext', a.FakeOffline);
    await warmCallSounds();
    playCallSound('connected');
    playCallSound('connected');
    expect(a.sources).toHaveLength(2);
    expect(a.sources.every((s) => !s.loop && s.start.mock.calls.length === 1)).toBe(true);
    // Connected is 0.5 s long.
    expect((a.sources[0] as unknown as { buffer: { length: number } }).buffer.length).toBe(
      Math.ceil(0.5 * 22050),
    );
    // Every sound was rendered once, at warm-up; playing rendered nothing more.
    expect(a.renders).toBe(CALL_SOUND_NAMES.length);
  });

  it('draws the designed picks: connected rises, ended falls, passed to agent is one low tick', () => {
    const a = fakeAudio();
    const notesOf = (name: keyof typeof CALL_SOUNDS): number[] => {
      a.notes.length = 0;
      CALL_SOUNDS[name].draw(new a.FakeOffline(1, 1, 22050) as unknown as BaseAudioContext, 0);
      return a.notes.map((n) => n.hz);
    };
    expect(notesOf('connected')).toEqual([523.25, 783.99]);
    expect(notesOf('reconnected')).toEqual(notesOf('connected'));
    expect(notesOf('ended')).toEqual([783.99, 659.25, 523.25]);
    expect(notesOf('passed-to-agent')).toEqual([220]);
    expect(notesOf('paused')).toEqual([659.25, 523.25]);
    expect(notesOf('failed')).toEqual([330, 330, 247]);
  });

  it('every sound fits inside the length it reports, so a loop never cuts a note', () => {
    const a = fakeAudio();
    for (const name of CALL_SOUND_NAMES) {
      a.notes.length = 0;
      const ctx = new a.FakeOffline(1, 1, 22050);
      const len = CALL_SOUNDS[name].draw(ctx as unknown as BaseAudioContext, 0);
      expect(len).toBeGreaterThan(0);
      expect(Math.max(...a.notes.map((n) => n.at))).toBeLessThan(len);
    }
  });

  it('a looping sound is rendered once and looped until it is stopped', async () => {
    const a = fakeAudio();
    vi.stubGlobal('AudioContext', a.FakeCtx);
    vi.stubGlobal('OfflineAudioContext', a.FakeOffline);
    await warmCallSounds();
    startCallSoundLoop('reconnecting');
    startCallSoundLoop('reconnecting');
    expect(a.sources).toHaveLength(1);
    expect(a.sources[0]?.loop).toBe(true);
    // One cycle of the reconnecting tone is 2.7 s.
    expect((a.sources[0] as unknown as { buffer: { length: number } }).buffer.length).toBe(
      Math.ceil(2.7 * 22050),
    );
    expect(playingCallSoundLoops()).toEqual(['reconnecting']);
    stopCallSoundLoop('reconnecting');
    expect(a.sources[0]?.stop).toHaveBeenCalled();
    expect(playingCallSoundLoops()).toEqual([]);
  });

  it('the connecting loop starts in the same task as the call, before any await', async () => {
    const a = fakeAudio();
    vi.stubGlobal('AudioContext', a.FakeCtx);
    vi.stubGlobal('OfflineAudioContext', a.FakeOffline);
    await warmCallSounds();
    syncCallSoundLoop('connecting', true);
    // No microtask or timer has run: the source is already started.
    expect(a.sources).toHaveLength(1);
    expect(a.sources[0]?.loop).toBe(true);
    expect(a.sources[0]?.start).toHaveBeenCalledTimes(1);
  });

  it('a sound not warmed at app start fails loudly rather than playing late', () => {
    const a = fakeAudio();
    vi.stubGlobal('AudioContext', a.FakeCtx);
    expect(() => startCallSoundLoop('connecting')).toThrow(/not warmed/);
    expect(playingCallSoundLoops()).toEqual([]);
  });

  it('wakes a suspended output, and syncs a loop on and off', async () => {
    const a = fakeAudio();
    vi.stubGlobal('AudioContext', a.FakeCtx);
    vi.stubGlobal('OfflineAudioContext', a.FakeOffline);
    await warmCallSounds();
    syncCallSoundLoop('agent-working', true);
    expect(playingCallSoundLoops()).toEqual(['agent-working']);
    syncCallSoundLoop('agent-working', false);
    syncCallSoundLoop('agent-working', false);
    expect(playingCallSoundLoops()).toEqual([]);
    // Left ringing: the reset between tests stops it.
    startCallSoundLoop('agent-calling');
  });

  it('a sound that cannot render fails the warm-up loudly', async () => {
    const a = fakeAudio();
    vi.stubGlobal('AudioContext', a.FakeCtx);
    class Broken extends a.FakeOffline {
      override startRendering(): Promise<AudioBuffer> {
        return Promise.reject(new Error('no renderer'));
      }
    }
    vi.stubGlobal('OfflineAudioContext', Broken);
    await expect(warmCallSounds()).rejects.toThrow('no renderer');
  });

  it('wakes an output the browser suspended, and says so if it will not wake', async () => {
    const a = fakeAudio();
    class Suspended extends a.FakeCtx {
      override state = 'suspended';
      override resume = vi.fn(() => Promise.reject(new Error('needs a gesture')));
    }
    vi.stubGlobal('AudioContext', Suspended);
    vi.stubGlobal('OfflineAudioContext', a.FakeOffline);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await warmCallSounds();
    playCallSound('ended');
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('needs a gesture'));
    err.mockRestore();
  });

  it('says so, loudly, when the browser cannot play a sound', async () => {
    vi.stubGlobal('AudioContext', undefined);
    await expect(warmCallSounds()).rejects.toThrow('no AudioContext');
  });
});
