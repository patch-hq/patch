// Settings → Voice calls → Direct calls on the phone (spec/07 § Direct calls,
// spec/15 § Settings tab): one setup for every device, On device or a cloud
// engine at each step, checked against this phone.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-test-renderer';
import type { SpeechEngineReport } from '@patch/wire/direct-call';
import { DirectCallsSection } from '../src/components/settings/DirectCallsSection';
import {
  renderRN as renderBase,
  findHost,
  queryHost,
  byTestId,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { useSettingsStore } from '../src/stores/settingsStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { resetHosts, seedSettings, settingsFixture } from './testUtils/settingsFixtures';

vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: vi.fn() }) }));
vi.mock('../src/api/rest', () => ({ api: { settings: vi.fn(), setPreferences: vi.fn() } }));

const PHONE: SpeechEngineReport = {
  stt: [
    { engine: 'android', where: 'device', models: ['android-on-device'] },
    { engine: 'groq', where: 'cloud', models: ['whisper-large-v3-turbo'] },
  ],
  tts: [
    { engine: 'android', where: 'device', models: ['android-tts'], voices: [] },
    { engine: 'elevenlabs', where: 'cloud', models: ['eleven_flash_v2_5'], voices: ['v-george'] },
  ],
};

const DEVICES = [
  {
    surfaceId: 'phone-1',
    surfaceKind: 'mobile',
    label: 'Pixel 9',
    issuedAt: 1,
    status: 'online',
    lastHeartbeat: 1,
    isCurrent: true,
    speechEngines: PHONE,
  },
  {
    surfaceId: 'mac-1',
    surfaceKind: 'desktop',
    label: 'Work Mac',
    issuedAt: 2,
    status: 'online',
    lastHeartbeat: 1,
    isCurrent: false,
    speechEngines: { stt: [], tts: [] },
  },
  {
    surfaceId: 'web-1',
    surfaceKind: 'web',
    label: 'Chrome',
    issuedAt: 3,
    status: 'online',
    lastHeartbeat: 1,
    isCurrent: false,
  },
] as never;

const ON_DEVICE = { stt: { engine: 'device' as const }, tts: { engine: 'device' as const } };

function seed(directCall?: unknown, current = 'phone-1'): void {
  seedSettings({
    devices: (DEVICES as unknown as { surfaceId: string }[]).map((d) => ({
      ...d,
      isCurrent: d.surfaceId === current,
    })) as never,
    preferences: { ...settingsFixture().preferences, directCall: directCall as never },
  });
}

const mounted: ReturnType<typeof renderBase>[] = [];
function renderRN(el: React.ReactElement): ReturnType<typeof renderBase> {
  const r = renderBase(el);
  mounted.push(r);
  return r;
}

beforeEach(() => {
  vi.mocked(api.setPreferences)
    .mockReset()
    .mockImplementation(async (patch) => ({
      preferences: { ...settingsFixture().preferences, ...patch },
    }));
  useSettingsStore.getState()._reset();
  resetHosts();
});
afterEach(() => {
  for (const r of mounted.splice(0)) act(() => r.unmount());
});

describe('Direct calls (phone)', () => {
  it('one setup, nothing chosen until picked: On device or each cloud engine with a key', () => {
    seed();
    const r = renderRN(<DirectCallsSection />);
    const row = textOf(findHost(r.root, byTestId('direct-stt-row')));
    expect(row).toContain('On device');
    expect(row).toContain('Groq Whisper');
    expect(findHost(r.root, byTestId('direct-stt-device')).props.accessibilityState.selected).toBe(
      false,
    );
    expect(queryHost(r.root, byTestId('direct-tts-row'))).toBeNull();
    expect(queryHost(r.root, byTestId('direct-mac-1-row'))).toBeNull();
  });

  it('On device on this phone runs Android’s own speech, with no model or voice to pick', () => {
    seed(ON_DEVICE);
    const r = renderRN(<DirectCallsSection />);
    expect(textOf(findHost(r.root, byTestId('direct-summary')))).toBe('Android → Android');
    expect(queryHost(r.root, byTestId('direct-stt-model'))).toBeNull();
    expect(queryHost(r.root, byTestId('direct-voice'))).toBeNull();
  });

  it('each pick is written to the one setup', async () => {
    seed();
    const r = renderRN(<DirectCallsSection />);
    await actAsync(async () => {
      findHost(r.root, byTestId('direct-stt-device')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({
      directCall: { stt: { engine: 'device' } },
    });
  });

  it('ElevenLabs shows its sound controls once its voice is chosen', () => {
    seed({
      stt: { engine: 'device' },
      tts: { engine: 'elevenlabs', model: 'eleven_flash_v2_5', voice: 'v-george' },
    });
    const r = renderRN(<DirectCallsSection />);
    expect(textOf(findHost(r.root, byTestId('direct-summary')))).toBe('Android → ElevenLabs');
    for (const c of ['tone', 'stability', 'similarity', 'style', 'speed']) {
      expect(queryHost(r.root, byTestId(`direct-${c}`))).not.toBeNull();
    }
    expect(textOf(findHost(r.root, byTestId('direct-speed-value')))).toBe('0.95×');
  });

  it('a cloud engine’s models are the provider’s list: a failed read says why, with Refresh', () => {
    seed({ stt: { engine: 'groq', model: 'whisper-large-v3-turbo' } });
    usePresenceStore.setState({
      hosts: {
        h1: {
          hostId: 'h1',
          online: true,
          host: {
            hostName: 'box',
            voiceKeys: { gemini: false, openai: false, groq: true },
            voiceCatalog: { groq: { error: 'Groq model list failed: HTTP 401', at: 1 } },
          },
        },
      },
    } as never);
    const r = renderRN(<DirectCallsSection />);
    expect(textOf(findHost(r.root, byTestId('direct-stt-model-status')))).toBe(
      "Could not read Groq's models: box: Groq model list failed: HTTP 401",
    );
    expect(queryHost(r.root, byTestId('direct-stt-model-refresh'))).not.toBeNull();
  });

  it('a phone that never reported says so', () => {
    seed(undefined, 'web-1');
    const r = renderRN(<DirectCallsSection />);
    expect(textOf(findHost(r.root, byTestId('direct-unreported')))).toBe(
      'This phone has not reported its speech engines yet.',
    );
  });
});
