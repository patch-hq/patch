// Settings → Voice: talking with Patch — which engine each voice conversation
// uses (account-wide), how Patch speaks, and the voice devices paired to the
// account. Dictation has its own page (DictationPage).

import type { JSX } from 'react';
import { Fragment, useState } from 'react';
import { voiceKeyHostStatus } from '@patch/wire/audio';
import { type VoiceBackend, type VoiceHandoff, type VoiceLayer } from '../../api/rest.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { AddVoiceDevice } from '../../components/AddVoiceDevice.js';
import { patchShared } from './sharedWrite.js';
import { DeviceRow, useDevices } from './DevicesPage.js';
import { VoiceProfilesGroup } from './VoiceProfilesGroup.js';
import { Group, Note, Pills, Row, SettingsPage } from './ui.js';
import { failed } from '../../lib/errorCopy.js';

/**
 * spec/07 § Voice is a config matrix — each cell is presented as a provider
 * and, for a hosted one, the variant of it; the backend and layer they stand
 * for are not shown.
 */
const PROVIDERS: readonly VoiceBackend[] = ['local', 'gemini', 'openai', 'elevenlabs'];
const PROVIDER_LABELS: Record<VoiceBackend, string> = {
  local: 'Local',
  gemini: 'Gemini',
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
};
const VARIANTS: readonly Exclude<VoiceLayer, 'direct'>[] = ['light', 'heavy'];
const VARIANT_NAMES: Record<VoiceBackend, Record<Exclude<VoiceLayer, 'direct'>, string>> = {
  local: { light: '', heavy: '' },
  gemini: { light: 'Flash', heavy: 'Thinking' },
  openai: { light: 'mini', heavy: 'full' },
  elevenlabs: { light: 'Haiku', heavy: 'Sonnet' },
};
/**
 * Rough dollars per minute of call, voice only (the chat's own agent turns ride
 * on the subscription). Gemini/OpenAI are estimated from token prices
 * (host/src/audio/voiceCost.ts) and Gemini Flash's measured $0.012 per 52s;
 * ElevenLabs is $0.08/min plus the LLM — Haiku measured at $0.086/min.
 */
const VARIANT_COST: Record<VoiceBackend, Record<Exclude<VoiceLayer, 'direct'>, string>> = {
  local: { light: 'free', heavy: 'free' },
  gemini: { light: '~$0.01/min', heavy: '~$0.02/min' },
  openai: { light: '~$0.03/min', heavy: '~$0.09/min' },
  elevenlabs: { light: '~$0.09/min', heavy: '~$0.10+/min' },
};
const variantOf = (layer: VoiceLayer): Exclude<VoiceLayer, 'direct'> =>
  layer === 'heavy' ? 'heavy' : 'light';
/** A hosted `direct` runs as `light`. */
const variantLabels = (backend: VoiceBackend): Record<Exclude<VoiceLayer, 'direct'>, string> => ({
  light: `${VARIANT_NAMES[backend].light} · ${VARIANT_COST[backend].light}`,
  heavy: `${VARIANT_NAMES[backend].heavy} · ${VARIANT_COST[backend].heavy}`,
});
const HANDOFFS: readonly VoiceHandoff[] = ['auto', 'always', 'never'];
const HANDOFF_LABELS: Record<VoiceHandoff, string> = {
  auto: 'Voice decides',
  always: 'Always',
  never: 'Never',
};
const HANDOFF_SUBS: Record<VoiceHandoff, string> = {
  auto: 'The voice answers simple questions itself and passes the rest to the chat’s agent.',
  always: 'Everything you say goes to the chat’s agent; the voice only reads out its reply.',
  never: 'The voice answers everything itself and never uses the chat’s agent.',
};
/** Dollars, to the penny that matters: two significant figures under 10 cents. */
function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.1) return `$${Number(usd.toPrecision(2))}`;
  return `$${usd.toFixed(2)}`;
}
const calls = (n: number): string => `${n} ${n === 1 ? 'call' : 'calls'}`;

type VoiceSurfaceKey = 'device' | 'handsFree' | 'call';
const SURFACES: { key: VoiceSurfaceKey; label: string }[] = [
  { key: 'handsFree', label: 'Hands-free' },
  { key: 'call', label: 'Call' },
  { key: 'device', label: 'Voice device' },
];

/**
 * What actually happens for a given cell, right now (spec/07 § Voice — a
 * config matrix — "Implemented today" / "Not implemented"). Mirrors
 * `packages/host/src/audio/server.ts`'s branching exactly, so this can
 * never claim a cell works when the host would refuse it — the UI accepts
 * every combination the schema does (nothing here blocks a selection), it
 * only tells you honestly what picking it will do.
 */
export function voiceCellStatus(
  surface: VoiceSurfaceKey,
  backend: VoiceBackend,
  layer?: VoiceLayer,
): string | null {
  if (backend === 'local' && layer !== undefined && layer !== 'direct') {
    return 'Not implemented yet — no front model built for local. Refused at connect time.';
  }
  return null;
}

export function VoicePage(): JSX.Element {
  return (
    <SettingsPage title="Voice" testid="settings-voice">
      <EngineGroup />
      <SpeakingGroup />
      <VoiceDevicesGroup />
      <VoiceProfilesGroup />
    </SettingsPage>
  );
}

/**
 * Per-surface voice config (spec/07 § Voice — a config matrix). Four surfaces,
 * each independently choosing an engine and (for the three conversational ones)
 * a front layer — deliberately a matrix to test against, not a fixed
 * architecture, so every combination is selectable and the row just says
 * honestly which ones already do something.
 */
function EngineGroup(): JSX.Element {
  const voiceConfig = usePreferencesStore((s) => s.preferences.voiceConfig);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  // Per-host key status (`host.host.voiceKeys`): a hosted cell names each
  // host that cannot run it — the host refuses its sessions there.
  const hosts = usePresenceStore((s) => s.hosts);
  const hostReports = Object.values(hosts).flatMap((h) =>
    h.host ? [{ hostName: h.host.hostName, voiceKeys: h.host.voiceKeys }] : [],
  );
  const write = (patch: Parameters<typeof update>[0]): void => {
    void update(patch).catch((e: Error) => pushError(failed('settings'), undefined, e.message));
  };

  return (
    <Group label="Voice conversations" testid="settings-voice-config">
      {SURFACES.map(({ key: surface, label }) => {
        const cell = voiceConfig[surface];
        const { backend, layer, handoff } = cell;
        const status = voiceCellStatus(surface, backend, layer);
        const keyStatus = voiceKeyHostStatus(backend, hostReports);
        const sub =
          status || keyStatus ? (
            <>
              {status ? (
                <span className="set-sub-line" data-testid={`voice-${surface}-status`}>
                  {status}
                </span>
              ) : null}
              {keyStatus ? (
                <span className="set-sub-line set-sub-error" data-testid={`voice-${surface}-keys`}>
                  {keyStatus}
                </span>
              ) : null}
            </>
          ) : undefined;
        return (
          <Fragment key={surface}>
            <Row
              title={label}
              sub={sub}
              testid={`voice-${surface}`}
              className="stack set-row-choices"
            >
              <Pills
                label={`${label} provider`}
                options={PROVIDERS}
                labels={PROVIDER_LABELS}
                value={backend}
                disabled={!loaded}
                testid={`voice-${surface}-engine`}
                onChange={(next) =>
                  write({
                    voiceConfig: {
                      ...voiceConfig,
                      [surface]: {
                        backend: next,
                        layer: next === 'local' ? 'direct' : variantOf(layer),
                        handoff,
                      },
                    },
                  })
                }
              />
              {backend !== 'local' ? (
                <Pills
                  label={`${label} variant`}
                  options={VARIANTS}
                  labels={variantLabels(backend)}
                  value={variantOf(layer)}
                  disabled={!loaded}
                  testid={`voice-${surface}-variant`}
                  onChange={(next) =>
                    write({
                      voiceConfig: { ...voiceConfig, [surface]: { ...cell, layer: next } },
                    })
                  }
                />
              ) : (
                <span className="set-sub" data-testid={`voice-${surface}-cost`}>
                  Free
                </span>
              )}
            </Row>
            {backend !== 'local' ? (
              <Row
                title={`${label}: pass to the chat’s agent`}
                sub={HANDOFF_SUBS[handoff]}
                testid={`voice-${surface}-handoff-row`}
                className="stack set-row-choices"
              >
                <Pills
                  label={`${label} hand-off`}
                  options={HANDOFFS}
                  labels={HANDOFF_LABELS}
                  value={handoff}
                  disabled={!loaded}
                  testid={`voice-${surface}-handoff`}
                  onChange={(next) =>
                    write({
                      voiceConfig: { ...voiceConfig, [surface]: { ...cell, handoff: next } },
                    })
                  }
                />
              </Row>
            ) : null}
          </Fragment>
        );
      })}
      {/* spec/07 § Call cost — what each host's voice calls have cost. */}
      {Object.entries(hosts).flatMap(([hostId, h]) => {
        const usage = h.host?.voiceUsage;
        if (!h.host || !usage) return [];
        return [
          <Note key={hostId} testid={`voice-usage-${hostId}`}>
            {`${h.host.hostName}: this month ${formatUsd(usage.monthUsd)} across ${calls(
              usage.monthCalls,
            )} · in all ${formatUsd(usage.allUsd)} across ${calls(usage.allCalls)}`}
          </Note>,
        ];
      })}
    </Group>
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

/** How Patch speaks on every host: the engine and its voice, and how often the chat's title is refreshed. */
function SpeakingGroup(): JSX.Element {
  const kokoroVoice = usePreferencesStore((s) => s.preferences.kokoroVoice);
  const ttsBackend = usePreferencesStore((s) => s.preferences.ttsBackend) ?? 'kokoro';
  const elevenLabsVoice = usePreferencesStore((s) => s.preferences.elevenLabsVoice);
  const elevenLabsModel = usePreferencesStore((s) => s.preferences.elevenLabsModel);
  const chatNameInterval = usePreferencesStore((s) => s.preferences.chatNameInterval);
  const loaded = usePreferencesStore((s) => s.loaded);
  const hosts = usePresenceStore((s) => s.hosts);
  // The account's voices come from whichever online host holds the key.
  const elevenHosts = Object.values(hosts).flatMap((h) => (h.host ? [h.host] : []));
  const elevenVoices = elevenHosts.find((h) => h.elevenLabsVoices !== undefined)?.elevenLabsVoices;
  const elevenError = elevenHosts.find(
    (h) => h.elevenLabsVoicesError !== undefined,
  )?.elevenLabsVoicesError;

  const titleOptions = [...new Set([0, 5, 10, 20, chatNameInterval])]
    .sort((x, y) => x - y)
    .map(String);
  const titleLabels = Object.fromEntries(
    titleOptions.map((n) => [n, n === '0' ? 'Set once' : `Every ${n} messages`]),
  );

  return (
    <Group label="Speaking" testid="voice-speaking">
      <Row title="Spoken replies">
        <Pills
          label="Speech engine"
          value={ttsBackend}
          options={['kokoro', 'elevenlabs'] as const}
          labels={{ kokoro: 'Kokoro', elevenlabs: 'ElevenLabs' }}
          testid="tts-backend"
          onChange={(v) => void patchShared('speech engine', { ttsBackend: v })}
        />
      </Row>
      {ttsBackend === 'elevenlabs' ? (
        <Row
          title="Voice"
          sub={
            elevenError !== undefined
              ? `Could not list ElevenLabs voices: ${elevenError}`
              : elevenVoices === undefined
                ? 'Add an ElevenLabs key under Hosts → Keys to list voices'
                : undefined
          }
        >
          <select
            aria-label="Voice"
            data-testid="elevenlabs-voice"
            value={elevenLabsVoice ?? ''}
            disabled={!loaded || elevenVoices === undefined}
            onChange={(e) => void patchShared('voice', { elevenLabsVoice: e.target.value })}
          >
            {elevenLabsVoice === undefined ? <option value="">—</option> : null}
            {(elevenVoices ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.category && v.category !== 'premade' ? `${v.name} (${v.category})` : v.name}
              </option>
            ))}
          </select>
        </Row>
      ) : null}
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
      <Row
        title="Chat title"
        sub="How often Patch rewrites a chat’s title as the conversation moves on."
        className="stack set-row-choices"
      >
        <Pills
          label="Chat title refresh"
          value={String(chatNameInterval)}
          options={titleOptions}
          labels={titleLabels}
          disabled={!loaded}
          testid="chat-name-interval"
          onChange={(v) => void patchShared('chat title refresh', { chatNameInterval: Number(v) })}
        />
      </Row>
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
    </Group>
  );
}
