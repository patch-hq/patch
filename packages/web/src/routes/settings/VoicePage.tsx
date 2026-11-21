// Settings → Voice: talking with Patch. One set of settings for every voice
// conversation — calls, hands-free and voice devices alike: the provider, its
// model and voice, whether it can pass work to the chat's agent, and what calls
// have used. Plus the voice devices paired to the account. Dictation and
// Meetings have their own pages.

import type { JSX } from 'react';
import { useState } from 'react';
import { GEMINI_VOICES, OPENAI_VOICES, voiceKeyHostStatus } from '@patch/wire/audio';
import { type VoiceBackend, type VoiceLayer, type VoiceSurfaceConfig } from '../../api/rest.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { AddVoiceDevice } from '../../components/AddVoiceDevice.js';
import { Toggle } from '../../components/Toggle.js';
import { patchShared } from './sharedWrite.js';
import { DeviceRow, useDevices } from './DevicesPage.js';
import { VoiceProfilesGroup } from './VoiceProfilesGroup.js';
import { Group, Note, Pills, Row, SettingsPage } from './ui.js';
import { failed } from '../../lib/errorCopy.js';
import { DEFAULT_VOICE_DEVICE_PROMPT } from '@patch/wire';
import { PromptRow } from './PromptRow.js';

const PROVIDERS: readonly VoiceBackend[] = ['local', 'gemini', 'openai', 'elevenlabs'];
const PROVIDER_LABELS: Record<VoiceBackend, string> = {
  local: 'Local',
  gemini: 'Gemini',
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
};
type Variant = Exclude<VoiceLayer, 'direct'>;
const VARIANTS: readonly Variant[] = ['light', 'heavy'];
const VARIANT_NAMES: Record<Exclude<VoiceBackend, 'local'>, Record<Variant, string>> = {
  gemini: { light: 'Flash 2.5 Native Audio', heavy: 'Gemini 3.8 Live Thinking' },
  openai: { light: 'GPT Realtime 2.1 mini', heavy: 'GPT Realtime 2.1' },
  elevenlabs: { light: 'Claude Haiku 4.5', heavy: 'Claude Sonnet 4.5' },
};
const variantOf = (layer: VoiceLayer): Variant => (layer === 'heavy' ? 'heavy' : 'light');

/** The three conversation entries share one config; `call` is the one shown. */
const SURFACES = ['call', 'handsFree', 'device'] as const;

/**
 * What actually happens for a config, right now. Mirrors
 * `packages/host/src/audio/server.ts`'s branching, so this never claims a
 * config works when the host would refuse it.
 */
export function voiceCellStatus(backend: VoiceBackend, layer?: VoiceLayer): string | null {
  if (backend === 'local' && layer !== undefined && layer !== 'direct') {
    return 'Not implemented yet — no front model built for local. Refused at connect time.';
  }
  return null;
}

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-GB');
const calls = (n: number): string => `${n} ${n === 1 ? 'call' : 'calls'}`;

export function VoicePage(): JSX.Element {
  return (
    <SettingsPage
      title="Voice calls"
      intro="Talking to a chat out loud: the voice engine, how it sounds, and who it recognises."
      experimental
      testid="settings-voice"
    >
      <ConversationGroup />
      <UsageGroup />
      <VoiceDevicesGroup />
      <VoiceProfilesGroup />
    </SettingsPage>
  );
}

/**
 * The voice conversation config (spec/07 § Voice). One choice drives calls,
 * hands-free and voice devices: it is written to all three cells.
 */
function ConversationGroup(): JSX.Element {
  const voiceConfig = usePreferencesStore((s) => s.preferences.voiceConfig);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const hosts = usePresenceStore((s) => s.hosts);
  const hostReports = Object.values(hosts).flatMap((h) =>
    h.host ? [{ hostName: h.host.hostName, voiceKeys: h.host.voiceKeys }] : [],
  );
  const cell = voiceConfig.call;
  const { backend, layer, handoff } = cell;
  const write = (next: VoiceSurfaceConfig): void => {
    const all = Object.fromEntries(SURFACES.map((k) => [k, next]));
    void update({ voiceConfig: { ...voiceConfig, ...all } }).catch((e: Error) =>
      pushError(failed('settings'), undefined, e.message),
    );
  };
  const status = voiceCellStatus(backend, layer);
  const keyStatus = voiceKeyHostStatus(backend, hostReports);
  return (
    <Group label="Engine" testid="settings-voice-config">
      <Row
        title="Provider"
        sub={
          status || keyStatus ? (
            <>
              {status ? (
                <span className="set-sub-line" data-testid="voice-status">
                  {status}
                </span>
              ) : null}
              {keyStatus ? (
                <span className="set-sub-line set-sub-error" data-testid="voice-keys">
                  {keyStatus}
                </span>
              ) : null}
            </>
          ) : undefined
        }
        testid="voice-provider"
        className="stack set-row-choices"
      >
        <Pills
          label="Voice provider"
          options={PROVIDERS}
          labels={PROVIDER_LABELS}
          value={backend}
          disabled={!loaded}
          testid="voice-engine"
          onChange={(next) =>
            write({
              backend: next,
              layer: next === 'local' ? 'direct' : variantOf(layer),
              handoff: handoff === 'never' ? 'never' : 'auto',
            })
          }
        />
      </Row>
      {backend === 'local' ? (
        <LocalCallRows />
      ) : (
        <>
          <Row title="Model" testid="voice-model" className="stack set-row-choices">
            <Pills
              label="Voice model"
              options={VARIANTS}
              labels={VARIANT_NAMES[backend]}
              value={variantOf(layer)}
              disabled={!loaded}
              testid="voice-variant"
              onChange={(next) => write({ ...cell, layer: next })}
            />
          </Row>
          <HostedVoiceRow backend={backend} />
          <Row
            title="Pass work to the chat’s agent"
            sub={
              handoff === 'never'
                ? 'The voice answers everything itself.'
                : 'The voice answers what it can and hands the rest to the agent.'
            }
            testid="voice-handoff-row"
          >
            <Toggle
              checked={handoff !== 'never'}
              disabled={!loaded}
              onChange={(on) => write({ ...cell, handoff: on ? 'auto' : 'never' })}
              testid="voice-handoff-toggle"
            />
          </Row>
        </>
      )}
    </Group>
  );
}

/** The voice a hosted provider speaks in. */
function HostedVoiceRow({ backend }: { backend: Exclude<VoiceBackend, 'local'> }): JSX.Element {
  if (backend === 'elevenlabs') return <ElevenLabsVoiceRow />;
  return <PresetVoiceRow backend={backend} />;
}

function PresetVoiceRow({ backend }: { backend: 'gemini' | 'openai' }): JSX.Element {
  const key = backend === 'gemini' ? 'geminiVoice' : 'openaiVoice';
  const value = usePreferencesStore((s) => s.preferences[key]);
  const loaded = usePreferencesStore((s) => s.loaded);
  const voices = backend === 'gemini' ? GEMINI_VOICES : OPENAI_VOICES;
  return (
    <Row title="Voice" testid={`voice-${backend}-voice-row`}>
      <select
        aria-label="Voice"
        data-testid={`voice-${backend}-voice`}
        value={value ?? ''}
        disabled={!loaded}
        onChange={(e) => void patchShared('voice', { [key]: e.target.value })}
      >
        {value === undefined ? <option value="">Provider default</option> : null}
        {voices.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** The account's ElevenLabs voices, listed by whichever online host holds the key. */
function ElevenLabsVoiceRow(): JSX.Element {
  const elevenLabsVoice = usePreferencesStore((s) => s.preferences.elevenLabsVoice);
  const loaded = usePreferencesStore((s) => s.loaded);
  const hosts = usePresenceStore((s) => s.hosts);
  const reports = Object.values(hosts).flatMap((h) => (h.host ? [h.host] : []));
  const voices = reports.find((h) => h.elevenLabsVoices !== undefined)?.elevenLabsVoices;
  const error = reports.find((h) => h.elevenLabsVoicesError !== undefined)?.elevenLabsVoicesError;
  return (
    <Row
      title="Voice"
      sub={
        error !== undefined
          ? `Could not list ElevenLabs voices: ${error}`
          : voices === undefined
            ? 'Add an ElevenLabs key under Hosts → Keys to list voices'
            : undefined
      }
      testid="voice-elevenlabs-voice-row"
    >
      <select
        aria-label="Voice"
        data-testid="elevenlabs-voice"
        value={elevenLabsVoice ?? ''}
        disabled={!loaded || voices === undefined}
        onChange={(e) => void patchShared('voice', { elevenLabsVoice: e.target.value })}
      >
        {elevenLabsVoice === undefined ? <option value="">—</option> : null}
        {(voices ?? []).map((v) => (
          <option key={v.id} value={v.id}>
            {v.category === 'generated'
              ? `${v.name} (designed)`
              : v.category && v.category !== 'premade'
                ? `${v.name} (${v.category})`
                : v.name}
          </option>
        ))}
      </select>
    </Row>
  );
}

/**
 * Standard Kokoro v1 voice options. Names match the `.pt` files in the
 * kokoro model's `voices/` directory — the sidecar loads the pack by name.
 * af_ = American Female, am_ = American Male, bf_ = British Female,
 * bm_ = British Male.
 */
const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: 'af_heart', label: 'Heart (American F)' },
  { id: 'af_bella', label: 'Bella (American F)' },
  { id: 'af_sky', label: 'Sky (American F)' },
  { id: 'af_sarah', label: 'Sarah (American F)' },
  { id: 'af_nicole', label: 'Nicole (American F)' },
  { id: 'am_adam', label: 'Adam (American M)' },
  { id: 'am_michael', label: 'Michael (American M)' },
  { id: 'bf_emma', label: 'Emma (British F)' },
  { id: 'bf_isabella', label: 'Isabella (British F)' },
  { id: 'bm_george', label: 'George (British M)' },
  { id: 'bm_lewis', label: 'Lewis (British M)' },
];

const ELEVENLABS_MODELS = [
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 (fastest)' },
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 (richer)' },
  { id: 'eleven_v3', label: 'v3 (most expressive)' },
] as const;

/**
 * Local calls: your words are transcribed on the host, every turn goes to the
 * chat's agent, and its reply is read out by Kokoro or ElevenLabs. The same
 * speech reads out announcements on house speakers.
 */
function LocalCallRows(): JSX.Element {
  const kokoroVoice = usePreferencesStore((s) => s.preferences.kokoroVoice);
  const ttsBackend = usePreferencesStore((s) => s.preferences.ttsBackend) ?? 'kokoro';
  const elevenLabsModel = usePreferencesStore((s) => s.preferences.elevenLabsModel);
  const loaded = usePreferencesStore((s) => s.loaded);
  return (
    <>
      <Row
        title="Read replies with"
        sub="Every turn goes to the chat’s agent; its reply is read out."
        testid="voice-local-tts"
      >
        <Pills
          label="Speech engine"
          value={ttsBackend}
          options={['kokoro', 'elevenlabs'] as const}
          labels={{ kokoro: 'Kokoro (free)', elevenlabs: 'ElevenLabs' }}
          testid="tts-backend"
          onChange={(v) => void patchShared('speech engine', { ttsBackend: v })}
        />
      </Row>
      {ttsBackend === 'elevenlabs' ? <ElevenLabsVoiceRow /> : null}
      {ttsBackend === 'elevenlabs' ? (
        <Row
          title="Model"
          sub={
            elevenLabsModel === undefined
              ? 'Fast for conversation, richer for announcements'
              : undefined
          }
        >
          <select
            aria-label="Model"
            data-testid="elevenlabs-model"
            value={elevenLabsModel ?? ''}
            disabled={!loaded}
            onChange={(e) =>
              void patchShared('model', {
                elevenLabsModel: e.target.value as (typeof ELEVENLABS_MODELS)[number]['id'],
              })
            }
          >
            {elevenLabsModel === undefined ? <option value="">Automatic</option> : null}
            {ELEVENLABS_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Row>
      ) : null}
      {ttsBackend === 'elevenlabs' ? null : (
        <Row
          title="Voice"
          sub={kokoroVoice === undefined ? 'Each host’s Kokoro default' : undefined}
          testid="voice-kokoro-voice-row"
        >
          <select
            aria-label="Voice"
            data-testid="kokoro-voice"
            value={kokoroVoice ?? ''}
            disabled={!loaded}
            onChange={(e) => void patchShared('voice', { kokoroVoice: e.target.value })}
          >
            {kokoroVoice === undefined ? <option value="">—</option> : null}
            {KOKORO_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </Row>
      )}
    </>
  );
}

/**
 * What voice has used across every host, in the providers' own units: tokens
 * for Gemini and OpenAI, credits for ElevenLabs, and the ElevenLabs plan's
 * credits used this period.
 */
function UsageGroup(): JSX.Element | null {
  const hosts = usePresenceStore((s) => s.hosts);
  const usages = Object.values(hosts).flatMap((h) =>
    h.host?.voiceUsage ? [h.host.voiceUsage] : [],
  );
  if (usages.length === 0) return null;
  const sum = (f: (u: (typeof usages)[number]) => number | undefined): number =>
    usages.reduce((n, u) => n + (f(u) ?? 0), 0);
  const plan = usages.find((u) => u.elevenLabsPlan !== undefined)?.elevenLabsPlan;
  const line = (callsN: number, tokens: number, credits: number): string =>
    [calls(callsN), `${fmtInt(tokens)} tokens`, `${fmtInt(credits)} ElevenLabs credits`].join(
      ' · ',
    );
  return (
    <Group label="Usage" testid="voice-usage">
      <Row title="This month" testid="voice-usage-month">
        <span className="set-sub">
          {line(
            sum((u) => u.monthCalls),
            sum((u) => u.monthTokens),
            sum((u) => u.monthCredits),
          )}
        </span>
      </Row>
      <Row title="In all" testid="voice-usage-all">
        <span className="set-sub">
          {line(
            sum((u) => u.allCalls),
            sum((u) => u.allTokens),
            sum((u) => u.allCredits),
          )}
        </span>
      </Row>
      {plan ? (
        <Row title="ElevenLabs plan" testid="voice-usage-plan">
          <span className="set-sub">{`${fmtInt(plan.used)} of ${fmtInt(plan.limit)} credits used`}</span>
        </Row>
      ) : null}
    </Group>
  );
}

/**
 * Voice devices paired to the account (spec/16). A voice device is a surface:
 * it pairs through the same single-use code as a phone (PairVoiceDevice) and is
 * revoked like one.
 */
function VoiceDevicesGroup(): JSX.Element {
  const { devices, revoke } = useDevices();
  const [pairing, setPairing] = useState(false);
  const voice = devices?.filter((d) => d.surfaceKind === 'voice-device') ?? null;
  const pairButton = pairing ? null : (
    <button
      type="button"
      className="set-btn"
      data-testid="voice-device-add-open"
      onClick={() => setPairing(true)}
    >
      Add device
    </button>
  );
  return (
    <Group label="Voice devices" testid="settings-voice-devices">
      {voice === null ? (
        <Note>Loading…</Note>
      ) : voice.length === 0 ? (
        <Row title="None yet" testid="voice-devices-empty">
          {pairButton}
        </Row>
      ) : (
        <>
          {voice.map((d) => (
            <DeviceRow key={d.surfaceId} device={d} onRevoke={revoke} />
          ))}
          {pairButton ? <Row title="Add another">{pairButton}</Row> : null}
        </>
      )}
      {pairing ? (
        <div className="set-row stack">
          <AddVoiceDevice onClose={() => setPairing(false)} />
        </div>
      ) : null}
      <SpeakingAloudPromptRow />
    </Group>
  );
}

/** What a voice device's voice and agent are told about being heard in a room (spec/16 § Speaking aloud). */
function SpeakingAloudPromptRow(): JSX.Element {
  const current = usePreferencesStore((s) => s.preferences.voiceDevicePrompt);
  return (
    <PromptRow
      id="voice-device"
      title="Speaking aloud"
      sub="What a device's voice and agent are told: they are heard out loud, by whoever is in the room."
      defaultText={DEFAULT_VOICE_DEVICE_PROMPT}
      current={current}
      onSave={(text) => patchShared('speaking aloud prompt', { voiceDevicePrompt: text })}
      onDefault={() =>
        patchShared('speaking aloud prompt', { voiceDevicePrompt: DEFAULT_VOICE_DEVICE_PROMPT })
      }
    />
  );
}
