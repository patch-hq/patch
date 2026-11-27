// Settings → Voice calls (spec/14 § Voice): the voice agent every call runs
// on, whether agents can call you, the call settings, what calls have used,
// and the voice devices paired to the account. Dictation and Meetings have
// their own pages.

import type { JSX } from 'react';
import { useState } from 'react';
import { DeviceAnswer } from '@patch/wire/audio';
import { HOST_KOKORO_VOICES, kokoroVoiceLabel } from '@patch/wire/direct-call';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { AddVoiceDevice } from '../../components/AddVoiceDevice.js';
import { Toggle } from '../../components/Toggle.js';
import { patchShared } from './sharedWrite.js';
import { DeviceRow, useDevices } from './DevicesPage.js';
import { VoiceProfilesGroup } from './VoiceProfilesGroup.js';
import { VoiceAgentGroup } from './VoiceAgentGroup.js';
import { DirectCallsGroup } from './DirectCallsGroup.js';
import { Group, Note, Pills, Row, SettingsPage } from './ui.js';
import { DEFAULT_VOICE_DEVICE_PROMPT, PAUSE_WHEN_QUIET_CHOICES } from '@patch/wire';
import { PromptRow } from './PromptRow.js';

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
      <VoiceAgentGroup />
      <AgentsCallingGroup />
      <CallsGroup />
      <DirectCallsGroup />
      <UsageGroup />
      <VoiceDevicesGroup />
      <VoiceProfilesGroup />
    </SettingsPage>
  );
}

/** Agents calling you (spec/07 § Agent-initiated voice). */
function AgentsCallingGroup(): JSX.Element {
  const canCall = usePreferencesStore((s) => s.preferences.agentsCanCall);
  const autoAnswer = usePreferencesStore((s) => s.preferences.agentCallAutoAnswer);
  const loaded = usePreferencesStore((s) => s.loaded);
  return (
    <Group label="Agents calling you" testid="settings-agents-calling">
      <Row title="Agents can call you" sub="Rings every device" testid="agents-can-call-row">
        <Toggle
          checked={canCall}
          disabled={!loaded}
          testid="agents-can-call"
          onChange={(on) => void patchShared('agents can call you', { agentsCanCall: on })}
        />
      </Row>
      {canCall ? (
        <Row
          title="Answer automatically in hands-free"
          sub="Pauses playback while the agent talks"
          testid="agent-call-auto-answer-row"
        >
          <Toggle
            checked={autoAnswer}
            disabled={!loaded}
            testid="agent-call-auto-answer"
            onChange={(on) => void patchShared('answer automatically', { agentCallAutoAnswer: on })}
          />
        </Row>
      ) : null}
    </Group>
  );
}

type QuietOption = `${(typeof PAUSE_WHEN_QUIET_CHOICES)[number]}`;
const QUIET_OPTIONS = PAUSE_WHEN_QUIET_CHOICES.map(String) as QuietOption[];
const QUIET_LABELS = Object.fromEntries(
  QUIET_OPTIONS.map((o) => [o, o === '0' ? 'Off' : `${o} min`]),
) as Record<QuietOption, string>;

/** Calls (spec/07 § Pause): pause a call nobody has spoken in for a while. */
function CallsGroup(): JSX.Element {
  const minutes = usePreferencesStore((s) => s.preferences.pauseWhenQuietMinutes);
  const loaded = usePreferencesStore((s) => s.loaded);
  return (
    <Group label="Calls" testid="settings-calls">
      <Row title="Pause when quiet for" testid="pause-when-quiet-row">
        <Pills
          label="Pause when quiet for"
          options={QUIET_OPTIONS}
          labels={QUIET_LABELS}
          value={String(minutes) as QuietOption}
          disabled={!loaded}
          testid="pause-when-quiet"
          onChange={(next) =>
            void patchShared('pause when quiet', {
              pauseWhenQuietMinutes: Number(next) as (typeof PAUSE_WHEN_QUIET_CHOICES)[number],
            })
          }
        />
      </Row>
    </Group>
  );
}

const ELEVENLABS_MODELS = [
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 (fastest)' },
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 (richer)' },
  { id: 'eleven_v3', label: 'v3 (most expressive)' },
] as const;

/** The account's ElevenLabs voices for host speech, listed by whichever online host holds the key. */
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
            ? 'Add an ElevenLabs key in Settings → Providers to list voices'
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
            {v.name}
          </option>
        ))}
      </select>
    </Row>
  );
}

/**
 * A voice device answering directly (spec/16): its words are transcribed on
 * the chat's host, every turn goes to the chat's agent, and the reply is read
 * out on the host by Kokoro or ElevenLabs. The same speech reads out
 * announcements on house speakers.
 */
function DeviceDirectRows(): JSX.Element {
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
            {HOST_KOKORO_VOICES.map((id) => (
              <option key={id} value={id}>
                {kokoroVoiceLabel(id)}
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
      <DeviceAnswerRow />
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

/**
 * How a voice device's conversation is answered (spec/16): by the account's
 * voice agent, or directly, with speech on the chat's host.
 */
function DeviceAnswerRow(): JSX.Element {
  const voiceConfig = usePreferencesStore((s) => s.preferences.voiceConfig);
  const loaded = usePreferencesStore((s) => s.loaded);
  return (
    <>
      <Row title="Answers with" testid="voice-device-answer-row">
        <Pills
          label="Voice devices answer with"
          options={DeviceAnswer.options}
          labels={{ agent: 'Voice agent', direct: 'Direct' }}
          value={voiceConfig.deviceAnswer}
          disabled={!loaded}
          testid="voice-device-answer"
          onChange={(deviceAnswer) =>
            void patchShared('voice devices', { voiceConfig: { ...voiceConfig, deviceAnswer } })
          }
        />
      </Row>
      {voiceConfig.deviceAnswer === 'direct' ? <DeviceDirectRows /> : null}
    </>
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
