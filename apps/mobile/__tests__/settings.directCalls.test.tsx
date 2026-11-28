// Settings → Voice calls → Direct calls on the phone (spec/07 § Direct calls,
// spec/15 § Settings tab): every linked device with its setup in one line,
// opening to its steps, offering only the engines it reported.

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

/** This phone's saved setup: Android's own engines. */
const PHONE_SETUP = {
  stt: { engine: 'android' as const, model: 'android-on-device' },
  tts: { engine: 'android' as const, model: 'android-tts' },
};

function seed(deviceDirectCall: Record<string, unknown> = { 'phone-1': PHONE_SETUP }): void {
  seedSettings({
    devices: DEVICES,
    preferences: { ...settingsFixture().preferences, deviceDirectCall: deviceDirectCall as never },
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

async function open(r: ReturnType<typeof renderRN>, id: string): Promise<void> {
  await actAsync(async () => {
    findHost(r.root, byTestId(`direct-${id}-row`)).props.onPress();
    await flush();
  });
}

describe('Direct calls (phone)', () => {
  it('lists each device with its setup in one line, No speech engine, or not reported', () => {
    seed();
    const r = renderRN(<DirectCallsSection />);
    expect(textOf(findHost(r.root, byTestId('direct-phone-1-summary')))).toBe('Android → Android');
    expect(textOf(findHost(r.root, byTestId('direct-mac-1-summary')))).toBe('No speech engine');
    expect(textOf(findHost(r.root, byTestId('direct-web-1-summary')))).toBe('Not reported yet');
  });

  it('opens to its steps with only the reported engines, labelled On device / Cloud', async () => {
    seed();
    const r = renderRN(<DirectCallsSection />);
    await open(r, 'phone-1');
    expect(textOf(findHost(r.root, byTestId('direct-phone-1-stt-row')))).toContain(
      'Android · On device',
    );
    expect(textOf(findHost(r.root, byTestId('direct-phone-1-stt-row')))).toContain(
      'Groq Whisper · Cloud',
    );
    expect(
      findHost(r.root, byTestId('direct-phone-1-stt-android')).props.accessibilityState.selected,
    ).toBe(true);
    // Android's voices have no sound controls and no voice list.
    expect(queryHost(r.root, byTestId('direct-phone-1-voice'))).toBeNull();
    expect(queryHost(r.root, byTestId('direct-phone-1-sound'))).toBeNull();
  });

  it('an unset phone reads Set up and chooses nothing; each step is written as it is chosen', async () => {
    seed({});
    const r = renderRN(<DirectCallsSection />);
    expect(textOf(findHost(r.root, byTestId('direct-phone-1-summary')))).toBe('Set up');
    await open(r, 'phone-1');
    expect(
      findHost(r.root, byTestId('direct-phone-1-stt-android')).props.accessibilityState.selected,
    ).toBe(false);
    expect(queryHost(r.root, byTestId('direct-phone-1-tts-row'))).toBeNull();
    await actAsync(async () => {
      findHost(r.root, byTestId('direct-phone-1-stt-groq')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({
      deviceDirectCall: { 'phone-1': { stt: { engine: 'groq' } } },
    });
  });

  it('ElevenLabs shows its sound controls once its voice is chosen', async () => {
    seed({
      'phone-1': {
        stt: { engine: 'android', model: 'android-on-device' },
        tts: { engine: 'elevenlabs', model: 'eleven_flash_v2_5', voice: 'v-george' },
      },
    });
    const r = renderRN(<DirectCallsSection />);
    expect(textOf(findHost(r.root, byTestId('direct-phone-1-summary')))).toBe(
      'Android → ElevenLabs',
    );
    await open(r, 'phone-1');
    for (const c of ['tone', 'stability', 'similarity', 'style', 'speed']) {
      expect(queryHost(r.root, byTestId(`direct-phone-1-${c}`))).not.toBeNull();
    }
    expect(textOf(findHost(r.root, byTestId('direct-phone-1-speed-value')))).toBe('0.95×');
  });

  it('a cloud engine’s models are the provider’s list: a failed read says why, with Refresh', async () => {
    seed({ 'phone-1': { stt: { engine: 'groq', model: 'whisper-large-v3-turbo' } } });
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
    await open(r, 'phone-1');
    expect(textOf(findHost(r.root, byTestId('direct-phone-1-stt-model-status')))).toBe(
      "Could not read Groq's models: box: Groq model list failed: HTTP 401",
    );
    expect(queryHost(r.root, byTestId('direct-phone-1-stt-model-refresh'))).not.toBeNull();
  });

  it('a device that never reported says so', async () => {
    seed();
    const r = renderRN(<DirectCallsSection />);
    await open(r, 'web-1');
    expect(textOf(findHost(r.root, byTestId('direct-web-1-unreported')))).toBe(
      'This device has not reported its speech engines yet.',
    );
  });
});
