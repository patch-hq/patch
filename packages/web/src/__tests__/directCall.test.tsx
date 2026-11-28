// spec/07 § Direct calls on web and desktop: no voice agent. The device's own
// engines read what the user says, the words go to the chat as voice turns,
// the agent's reply is read aloud here, and the bar says what is happening.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sounds = vi.hoisted(() => ({ loops: new Map<string, boolean>(), cues: [] as string[] }));
vi.mock('../lib/callSound.js', () => ({
  playCallSound: (cue: string) => void sounds.cues.push(cue),
  syncCallSoundLoop: (name: string, on: boolean) => void sounds.loops.set(name, on),
}));
import { act, cleanup, render, screen } from '@testing-library/react';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore, type HostPresence } from '../stores/presenceStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { NOT_SET_UP } from '@patch/wire/direct-call';
import { VoiceBar } from '../components/VoiceBar.js';
import { endVoiceCall } from '../lib/voiceController.js';
import { startDirectCall, directCallActive, directCallLine } from '../lib/direct/directCall.js';
import { deviceSpeechEngines } from '../lib/direct/engines.js';
import { startSpeechEngineReports } from '../lib/direct/engineReport.js';
import type { VoiceRecording } from '../lib/voiceRecorder.js';
import type { PreparedSpeech } from '@patch/wire/direct-call-runtime';
import type { ChatRow } from '../stores/types.js';

function hostWithKeys(ids: string[]): HostPresence {
  return {
    hostId: 'h1',
    online: true,
    host: {
      hostName: 'box',
      providerKeys: ids.map((id) => ({ id, source: 'ui', envSet: false })),
    },
  } as unknown as HostPresence;
}

function row(running: boolean): ChatRow {
  return {
    chatId: 'c1',
    chatStatus: { state: running ? 'running' : 'idle', since: 5_000 },
  } as unknown as ChatRow;
}

function fakeRecorder() {
  let onPcm: (pcm: Int16Array) => void = () => {};
  const cancel = vi.fn();
  const rec: VoiceRecording = {
    onLevel: () => {},
    onPcm: (cb) => {
      onPcm = cb;
    },
    stop: async () => new Blob(),
    cancel,
  };
  const speak = (ms: number, loud: boolean) => {
    for (let t = 0; t < ms; t += 20) {
      const f = new Int16Array(320);
      if (loud) for (let i = 0; i < f.length; i++) f[i] = Math.round(8000 * Math.sin(i / 3));
      onPcm(f);
    }
  };
  return { rec, speak, cancel };
}

/** This browser's saved direct-call setup: the cloud engines its host has keys for. */
const PREFS = {
  ...DEFAULT_PREFERENCES,
  deviceDirectCall: {
    s1: {
      stt: { engine: 'groq' as const, model: 'whisper-large-v3-turbo' },
      tts: { engine: 'openai' as const, model: 'gpt-4o-mini-tts', voice: 'alloy' },
    },
  },
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};

beforeEach(() => {
  useVoiceStore.setState({ call: null, session: null, note: null });
  usePresenceStore.setState({ hosts: { h1: hostWithKeys(['groq', 'openai']) }, surfaceId: 's1' });
  usePreferencesStore.setState({ preferences: { ...PREFS } });
  useChatStore.setState({ chats: { c1: row(false) }, timelines: { c1: [] } });
});
afterEach(() => {
  endVoiceCall({ silent: true });
  cleanup();
});

describe('direct call', () => {
  it('a browser with no keys has No speech engine and nothing starts', async () => {
    usePresenceStore.setState({ hosts: { h1: hostWithKeys([]) } });
    const pushError = vi.spyOn(useUiStore.getState(), 'pushError');
    await startDirectCall('c1');
    expect(useVoiceStore.getState().call).toBeNull();
    expect(pushError).toHaveBeenCalledWith('Cannot call direct: No speech engine');
  });

  it('a browser with engines but no saved setup is not set up: nothing is chosen for it', async () => {
    usePreferencesStore.setState({ preferences: { ...DEFAULT_PREFERENCES } });
    const pushError = vi.spyOn(useUiStore.getState(), 'pushError');
    await startDirectCall('c1');
    expect(useVoiceStore.getState().call).toBeNull();
    expect(pushError).toHaveBeenCalledWith(`Cannot call direct: ${NOT_SET_UP}`);
  });

  it('reads speech with the cloud engine, sends it as a voice turn, and reads the reply aloud', async () => {
    const mic = fakeRecorder();
    const posts: [string, Record<string, unknown>][] = [];
    const played: string[] = [];
    const post = vi.fn(async (path: string, body: object) => {
      posts.push([path, body as Record<string, unknown>]);
      if (path.endsWith('/transcribe')) return { transcript: 'what is the status' };
      if (path.endsWith('/speak')) return { pcmBase64: 'AAAA', sampleRate: 24000 };
      return { ok: true };
    }) as never;
    await startDirectCall('c1', {
      recorder: async () => mic.rec,
      turn: async () => ({ label: 'Smart Turn', probability: async () => 0.9 }),
      post,
      player: () => ({
        prepare: (): PreparedSpeech => ({
          play: async () => void played.push('piece'),
          stop: () => {},
        }),
        close: () => {},
      }),
    });
    render(<VoiceBar />);
    // The line is up once the microphone is: connected plays, connecting stops.
    expect(sounds.cues).toContain('connected');
    expect(sounds.loops.get('connecting')).toBe(false);
    expect(screen.getByTestId('voice-bar-head')).toHaveTextContent('On call · direct');
    expect(screen.getByTestId('voice-bar-setup')).toHaveTextContent('Groq Whisper → OpenAI');
    expect(screen.queryByTestId('voice-bar-mode')).toBeNull();

    mic.speak(200, false);
    mic.speak(1500, true);
    mic.speak(800, false);
    await flush();
    expect(posts.find(([p]) => p.endsWith('/transcribe'))?.[1]).toMatchObject({
      chatId: 'c1',
      engine: 'groq',
    });
    expect(posts.find(([p]) => p.endsWith('/turn'))?.[1]).toEqual({
      chatId: 'c1',
      text: 'what is the status',
    });

    // The agent works: the bar counts it.
    act(() => useChatStore.setState({ chats: { c1: row(true) } }));
    expect(useVoiceStore.getState().call?.direct?.status.workingSince).toBe(5_000);
    expect(screen.getByTestId('voice-bar-direct-status').textContent).toMatch(
      /^Agent working · \d+:\d\d$/,
    );

    // Its turn ends with a reply: that is read aloud.
    act(() =>
      useChatStore.setState({
        chats: { c1: row(false) },
        timelines: {
          c1: [{ seq: 7, at: 1, kind: 'message', role: 'assistant', content: 'All green.' }],
        },
      }),
    );
    await flush();
    expect(sounds.loops.get('agent-working')).toBe(false);
    expect(posts.find(([p]) => p.endsWith('/speak'))?.[1]).toMatchObject({
      engine: 'openai',
      text: 'All green.',
    });
    expect(played).toEqual(['piece']);

    endVoiceCall({ silent: true });
    expect(directCallActive()).toBe(false);
    expect(mic.cancel).toHaveBeenCalled();
    expect(useVoiceStore.getState().call).toBeNull();
  });

  it('a failed engine shows on the bar naming it, and the call stays open', async () => {
    const mic = fakeRecorder();
    await startDirectCall('c1', {
      recorder: async () => mic.rec,
      turn: async () => ({ label: 'Smart Turn', probability: async () => 0.9 }),
      post: (async (path: string) => {
        if (path.endsWith('/transcribe')) throw new Error('no Groq key is set on this host');
        return {};
      }) as never,
      player: () => ({
        prepare: () => ({ play: async () => {}, stop: () => {} }),
        close: () => {},
      }),
    });
    render(<VoiceBar />);
    mic.speak(200, false);
    mic.speak(1500, true);
    mic.speak(800, false);
    await flush();
    expect(screen.getByTestId('voice-bar-note')).toHaveTextContent(
      'Groq Whisper failed — no Groq key is set on this host',
    );
    expect(directCallActive()).toBe(true);
  });

  it('a Smart Turn model that will not load is named, and the long pause still sends', async () => {
    const mic = fakeRecorder();
    const sent: string[] = [];
    usePreferencesStore.setState({
      preferences: { ...PREFS, dictationPauseSeconds: 2 },
    });
    await startDirectCall('c1', {
      recorder: async () => mic.rec,
      turn: async () => {
        throw new Error("the server's Smart Turn model does not match its pinned checksum");
      },
      post: (async (path: string, body: { text?: string }) => {
        if (path.endsWith('/transcribe')) return { transcript: 'hello out there' };
        if (path.endsWith('/turn')) sent.push(body.text ?? '');
        return {};
      }) as never,
      player: () => ({
        prepare: () => ({ play: async () => {}, stop: () => {} }),
        close: () => {},
      }),
    });
    mic.speak(200, false);
    mic.speak(1500, true);
    mic.speak(800, false);
    await flush();
    expect(useVoiceStore.getState().call?.direct?.status.failure).toMatch(
      /^Smart Turn failed — .*pinned checksum/,
    );
    mic.speak(1400, false);
    await flush();
    expect(sent).toEqual(['hello out there']);
  });
});

describe('engines on this device', () => {
  it('the desktop reports Parakeet and Kokoro once downloaded; a browser reports none', async () => {
    expect(await deviceSpeechEngines(undefined)).toEqual({ stt: [], tts: [] });
    const bridge = {
      localStt: { status: async () => ({ installed: true }), read: async () => '' },
      localTts: {
        status: async () => ({ installed: true, voices: ['af_heart'], model: 'kokoro-82m-v1.0' }),
      },
    } as never;
    expect(await deviceSpeechEngines(bridge)).toEqual({
      stt: [{ engine: 'parakeet', where: 'device', models: ['parakeet-tdt-0.6b-v3'] }],
      tts: [
        { engine: 'kokoro', where: 'device', models: ['kokoro-82m-v1.0'], voices: ['af_heart'] },
      ],
    });
  });

  it('reports on connect, and again only when the engines change', async () => {
    const sent: unknown[] = [];
    let report = { stt: [], tts: [] } as { stt: unknown[]; tts: unknown[] };
    const r = startSpeechEngineReports(
      (e) => sent.push(e),
      async () => report as never,
    );
    r.report();
    await flush();
    expect(sent).toEqual([{ type: 'surface.speech_engines', stt: [], tts: [] }]);
    usePresenceStore.setState({ hosts: {} });
    await flush();
    expect(sent.length).toBe(1);
    report = { stt: [{ engine: 'groq', where: 'cloud', models: ['m'] }], tts: [] };
    usePresenceStore.setState({ hosts: { h1: hostWithKeys(['groq']) } });
    await flush();
    expect(sent.length).toBe(2);
    r.report();
    await flush();
    expect(sent.length).toBe(3);
    r.stop();
  });

  it('the bar line names what the line is doing', () => {
    expect(directCallLine({ line: 'working', workingSince: 0 }, 42_000)).toBe(
      'Agent working · 0:42',
    );
    expect(directCallLine({ line: 'speaking', workingSince: null }, 0)).toBe('Speaking');
    expect(directCallLine({ line: 'sending', workingSince: null }, 0)).toBe('Thinking…');
  });
});

describe('pausing a direct call', () => {
  it('pause closes the line and keeps the call; resume reopens it on the same chat', async () => {
    const { pauseVoiceCall, resumeVoiceCall } = await import('../lib/voiceController.js');
    const opened: ReturnType<typeof fakeRecorder>[] = [];
    await startDirectCall('c1', {
      recorder: async () => {
        const mic = fakeRecorder();
        opened.push(mic);
        return mic.rec;
      },
      turn: async () => ({ label: 'Smart Turn', probability: async () => 0.9 }),
      post: (async () => ({})) as never,
      player: () => ({
        prepare: () => ({ play: async () => {}, stop: () => {} }),
        close: () => {},
      }),
    });
    expect(directCallActive()).toBe(true);
    pauseVoiceCall();
    expect(directCallActive()).toBe(false);
    expect(opened[0]!.cancel).toHaveBeenCalled();
    expect(useVoiceStore.getState().call?.paused).toBe('button');
    expect(useVoiceStore.getState().call?.direct).not.toBeNull();
    await resumeVoiceCall();
    await flush();
    expect(directCallActive()).toBe(true);
    expect(opened.length).toBe(2);
    expect(useVoiceStore.getState().call?.paused).toBeNull();
  });
});
