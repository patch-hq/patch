// spec/07 § Direct calls on the phone: Android's own engines (or the account's
// cloud ones through the chat's host) behind the shared runtime; the words go
// to the chat as voice turns and the agent's reply is read aloud on the phone.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { useUiStore } from '../src/stores/uiStore';
import {
  deviceSpeechEngines,
  directCallActive,
  endDirectCall,
  pauseDirectCall,
  resumeDirectCall,
  startDirectCall,
  type PatchDirectCallModule,
} from '../src/lib/directCall';

vi.mock('../src/lib/callSounds', () => ({ playCallSound: vi.fn(async () => {}) }));

function fakeModule(over: Partial<PatchDirectCallModule> = {}) {
  const calls = { transcribe: 0, speak: [] as string[], turn: 0 };
  const mod: PatchDirectCallModule = {
    deviceEngines: async () => ({ stt: true, voices: ['en-gb-x-gba-local'] }),
    transcribe: async () => {
      calls.transcribe++;
      return 'is the build green';
    },
    speak: async (text) => void calls.speak.push(text),
    stopSpeaking: async () => {},
    playPcm: async () => {},
    stopPcm: async () => {},
    loadSmartTurn: async () => {},
    turnProbability: async () => {
      calls.turn++;
      return 0.9;
    },
    ...over,
  };
  return { mod, calls };
}

function fakeMic() {
  let frame: (pcm: Int16Array) => void = () => {};
  const mic = {
    start: vi.fn(async (onFrame: (pcm: Int16Array) => void) => {
      frame = onFrame;
    }),
    stop: vi.fn(async () => {}),
  };
  const say = (ms: number, loud: boolean) => {
    for (let t = 0; t < ms; t += 20) {
      const f = new Int16Array(320);
      if (loud) for (let i = 0; i < f.length; i++) f[i] = Math.round(8000 * Math.sin(i / 3));
      frame(f);
    }
  };
  return { mic, say };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(async () => {
  await endDirectCall();
  useVoiceStore.setState({ activeSession: null, callDirect: null, callPaused: null });
  usePresenceStore.setState({ hosts: {}, surfaceId: 's-phone' } as never);
  useSettingsStore.setState({
    data: {
      preferences: {
        ...DEFAULT_SHARED_SETTINGS,
        // This phone's saved direct-call setup: Android's own engines.
        deviceDirectCall: {
          's-phone': {
            stt: { engine: 'android', model: 'on-device' },
            tts: { engine: 'android', model: 'android-tts', voice: 'en-gb-x-gba-local' },
          },
        },
      },
    },
  } as never);
  useChatStore.setState({
    chats: { c1: { chatId: 'c1', chatStatus: { state: 'idle', since: 0 } } },
    timelines: { c1: [] },
  } as never);
});

describe('the phone’s engines', () => {
  it('reports Android’s recogniser and its installed voices', async () => {
    expect(await deviceSpeechEngines(fakeModule().mod)).toEqual({
      stt: [{ engine: 'android', where: 'device', models: ['on-device'] }],
      tts: [
        {
          engine: 'android',
          where: 'device',
          models: ['android-tts'],
          voices: ['en-gb-x-gba-local'],
        },
      ],
    });
    const none = fakeModule({ deviceEngines: async () => ({ stt: false, voices: [] }) });
    expect(await deviceSpeechEngines(none.mod)).toEqual({ stt: [], tts: [] });
  });
});

describe('a direct call on the phone', () => {
  it('hears, sends a voice turn, and reads the agent’s reply with Android’s voice', async () => {
    const { mod, calls } = fakeModule();
    const { mic, say } = fakeMic();
    const posts: [string, object][] = [];
    const holdAudio = vi.fn(async () => {});
    await startDirectCall('c1', {
      mod,
      mic,
      holdAudio,
      post: (async (path: string, body: object) => {
        posts.push([path, body]);
        return {};
      }) as never,
    });
    expect(useVoiceStore.getState().callDirect?.setup).toBe('Android → Android');
    expect(directCallActive()).toBe(true);
    expect(holdAudio).toHaveBeenCalledWith('c1');
    say(200, false);
    say(1500, true);
    say(800, false);
    await flush();
    expect(calls.turn).toBeGreaterThan(0);
    expect(posts).toContainEqual([
      '/api/voice/direct/turn',
      { chatId: 'c1', text: 'is the build green' },
    ]);
    useChatStore.setState({
      chats: { c1: { chatId: 'c1', chatStatus: { state: 'running', since: 5 } } },
    } as never);
    expect(useVoiceStore.getState().callDirect?.status.workingSince).toBe(5);
    useChatStore.setState({
      chats: { c1: { chatId: 'c1', chatStatus: { state: 'idle', since: 9 } } },
      timelines: {
        c1: [{ seq: 3, at: 1, kind: 'message', role: 'assistant', content: 'Yes, green.' }],
      },
    } as never);
    await flush();
    expect(calls.speak).toEqual(['Yes, green.']);
    // spec/07 § Call cost — hanging up tells the host, which leaves the call's line.
    // The phone's own engines sent nothing to a cloud engine, so nothing is counted.
    await endDirectCall();
    expect(posts).toContainEqual([
      '/api/voice/direct/end',
      {
        chatId: 'c1',
        startedAt: expect.any(Number),
        usage: {
          stt: { engine: 'android', model: expect.any(String), utteranceSeconds: [] },
          tts: { engine: 'android', model: 'android-tts', requests: 0, characters: 0 },
        },
      },
    ]);
  });
});

describe('direct call refusals and pause', () => {
  it('a phone with no engine and no keys has No speech engine', async () => {
    const pushError = vi.spyOn(useUiStore.getState(), 'pushError');
    const { mod } = fakeModule({ deviceEngines: async () => ({ stt: false, voices: [] }) });
    await startDirectCall('c1', { mod, mic: fakeMic().mic });
    expect(useVoiceStore.getState().activeSession).toBeNull();
    expect(pushError).toHaveBeenCalledWith('Cannot call direct: No speech engine');
  });

  it('a phone with engines but no saved setup runs on its first engines', async () => {
    useSettingsStore.setState({
      data: { preferences: { ...DEFAULT_SHARED_SETTINGS } },
    } as never);
    const pushError = vi.spyOn(useUiStore.getState(), 'pushError');
    await startDirectCall('c1', { mod: fakeModule().mod, mic: fakeMic().mic });
    expect(pushError).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().activeSession).not.toBeNull();
  });

  it('pause releases the microphone and keeps the call; resume opens it again', async () => {
    const { mod } = fakeModule();
    const { mic } = fakeMic();
    await startDirectCall('c1', { mod, mic, post: (async () => ({})) as never });
    await pauseDirectCall();
    expect(directCallActive()).toBe(false);
    expect(mic.stop).toHaveBeenCalled();
    expect(useVoiceStore.getState().callDirect).not.toBeNull();
    await resumeDirectCall();
    expect(directCallActive()).toBe(true);
    expect(mic.start).toHaveBeenCalledTimes(2);
    await endDirectCall();
    expect(useVoiceStore.getState().activeSession).toBeNull();
  });
});

describe('a direct call over a paused call', () => {
  it('replaces the paused call', async () => {
    useVoiceStore.setState({
      activeSession: { sessionId: 's-old', chatId: 'c9', audioUrl: '/a', startedAt: 1 },
      callPaused: 'button',
    } as never);
    const hangUp = vi.fn(async () => {
      useVoiceStore.setState({ activeSession: null, callPaused: null } as never);
    });
    const { mod } = fakeModule();
    await startDirectCall('c1', {
      mod,
      mic: fakeMic().mic,
      hangUp,
      post: (async () => ({})) as never,
    });
    expect(hangUp).toHaveBeenCalled();
    expect(useVoiceStore.getState().activeSession?.chatId).toBe('c1');
    expect(useVoiceStore.getState().callDirect).not.toBeNull();
    await endDirectCall();
  });
});
