// Settings → Voice: which engine each voice surface uses (account-wide), how
// one host speaks, the voice devices paired to the account, and this host's
// dictate shortcut.

import type { JSX } from 'react';
import { Fragment, useEffect, useState } from 'react';
import {
  SPEECH_TO_TEXT_LABEL,
  SpeechToTextEngine,
  voiceKeyHostStatus,
  type ComputerDictationEngine,
  type DictationConfig,
  type DictationEngine,
  type PhoneDictationEngine,
} from '@patch/wire/audio';
import { DICTATION_PAUSE_CHOICES } from '@patch/wire';
import { type VoiceBackend, type VoiceHandoff, type VoiceLayer } from '../../api/rest.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { chordFromEvent, chordGlyphs } from '../../lib/dictateChord.js';
import { getDesktopBridge } from '../../lib/desktopBridge.js';
import { shortcutLabel } from '../../lib/shortcuts.js';
import { PairVoiceDevice } from '../../components/PairVoiceDevice.js';
import { Toggle } from '../../components/Toggle.js';
import { patchShared } from './sharedWrite.js';
import { DeviceRow, useDevices } from './DevicesPage.js';
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
/** spec/07 § Dictation engines — a computer has no recogniser of its own. */
const PHONE_DICTATION: readonly PhoneDictationEngine[] = [
  'device',
  'deepgram',
  'elevenlabs',
  'host',
  'whisper',
];
const COMPUTER_DICTATION: readonly ComputerDictationEngine[] = [
  'deepgram',
  'elevenlabs',
  'host',
  'local',
  'whisper',
];
const DICTATION_LABELS: Record<DictationEngine, string> = {
  local: 'Parakeet on this computer',
  device: 'Built-in',
  deepgram: 'Deepgram',
  elevenlabs: 'ElevenLabs',
  host: 'On this host',
  whisper: 'Whisper',
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
  if (backend !== 'local' && surface === 'device') {
    return 'Not implemented yet for this surface. Refused at connect time.';
  }
  if (backend === 'local' && layer !== undefined && layer !== 'direct') {
    return 'Not implemented yet — no front model built for local. Refused at connect time.';
  }
  return null;
}

export function VoicePage(): JSX.Element {
  return (
    <SettingsPage title="Voice" testid="settings-voice">
      <SpeechToTextGroup />
      <DictationEnginesGroup />
      <EngineGroup />
      <DictationGroup />
      <ShortcutGroup />
      <SpeakingGroup />
      <VoiceDevicesGroup />
    </SettingsPage>
  );
}

/**
 * Dictation mode (spec/07 § Dictation mode): whether Smart Turn decides when
 * the speaker has finished, and the silence that sends regardless.
 */
function DictationGroup(): JSX.Element {
  const pause = usePreferencesStore((s) => s.preferences.dictationPauseSeconds);
  const detect = usePreferencesStore((s) => s.preferences.dictationTurnDetection);
  const loaded = usePreferencesStore((s) => s.loaded);
  return (
    <Group label="Dictation mode" testid="settings-voice-dictation">
      <Row title="Detect when I've finished" testid="dictation-turn-detection">
        <Toggle
          checked={detect}
          disabled={!loaded}
          onChange={(next) => void patchShared('turn detection', { dictationTurnDetection: next })}
          testid="dictation-turn-detection-toggle"
        />
      </Row>
      <Row title={detect ? 'Send anyway after a pause of' : 'Send after a pause of'}>
        <Pills
          label="Dictation pause"
          options={DICTATION_PAUSE_CHOICES}
          labels={Object.fromEntries(DICTATION_PAUSE_CHOICES.map((c) => [c, `${c}s`]))}
          value={String(pause) as (typeof DICTATION_PAUSE_CHOICES)[number]}
          disabled={!loaded}
          testid="dictation-pause"
          onChange={(next) =>
            void patchShared('dictation pause', { dictationPauseSeconds: Number(next) })
          }
        />
      </Row>
    </Group>
  );
}

/**
 * The dictate chord, per host (lib/dictateChord.ts). "Change" listens for
 * the next chord with ⌘/Ctrl in it; Esc leaves the old one. The listener runs
 * in the capture phase and stops the event there, so the chord being recorded
 * doesn't also fire whatever it is bound to.
 */
function ShortcutGroup(): JSX.Element {
  const chord = useUiStore((s) => s.dictateChord);
  const setChord = useUiStore((s) => s.setDictateChord);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }
      const next = chordFromEvent(e);
      if (!next) return;
      setChord(next);
      setRecording(false);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, setChord]);

  return (
    <Group label="Shortcut" testid="settings-voice-shortcut">
      <Row title="Dictate">
        <kbd className="set-chord" data-testid="dictate-chord">
          {recording ? 'Press keys…' : shortcutLabel(chordGlyphs(chord))}
        </kbd>
        <button
          type="button"
          className="set-btn"
          data-testid="dictate-chord-change"
          aria-pressed={recording}
          onClick={() => setRecording(!recording)}
        >
          {recording ? 'Cancel' : 'Change'}
        </button>
      </Row>
    </Group>
  );
}

/**
 * "Parakeet on this computer": whether the desktop app has its own copy of the
 * models, and the download when it has not. In a browser there is nothing to
 * download into, and the line says so.
 */
function LocalSttStatus(): JSX.Element {
  const stt = getDesktopBridge()?.localStt;
  const [status, setStatus] = useState<{ installed: boolean; downloadBytes: number } | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!stt) return;
    stt.status().then(setStatus, (e: Error) => setError(e.message));
  }, [stt]);
  if (!stt) {
    return (
      <span className="set-sub-line set-sub-error" data-testid="dictation-local-status">
        Only runs in the desktop app. Sessions from a browser are refused.
      </span>
    );
  }
  const download = (): void => {
    setError(null);
    setProgress({ received: 0, total: status?.downloadBytes ?? 0 });
    stt
      .download(setProgress)
      .then(() => stt.status())
      .then(setStatus)
      .catch((e: Error) => setError(e.message))
      .finally(() => setProgress(null));
  };
  const mb = (n: number): string => `${Math.round(n / 1_000_000)} MB`;
  return (
    <span className="set-sub-line" data-testid="dictation-local-status">
      {error !== null ? <span className="set-sub-error">{error} </span> : null}
      {progress !== null ? (
        `Downloading ${mb(progress.received)} of ${mb(progress.total)}`
      ) : status === null ? (
        'Checking this computer…'
      ) : status.installed ? (
        'Downloaded on this computer'
      ) : (
        <>
          Not downloaded ({mb(status.downloadBytes)}).{' '}
          <button
            type="button"
            className="set-btn"
            data-testid="dictation-local-download"
            onClick={download}
          >
            Download
          </button>
        </>
      )}
    </span>
  );
}

/**
 * Where dictation's words come from (spec/07 § Dictation engines): one engine
 * for the phone app, one for web and desktop, and whether Whisper tidies up a
 * live engine's words as dictation goes on.
 */
function SpeechToTextGroup(): JSX.Element {
  const voiceConfig = usePreferencesStore((s) => s.preferences.voiceConfig);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  return (
    <Group label="Speech to text" testid="settings-voice-stt">
      <Row title="Reads speech with" testid="stt-row">
        <Pills
          label="Speech to text"
          options={SpeechToTextEngine.options}
          labels={SPEECH_TO_TEXT_LABEL}
          value={voiceConfig.speechToText}
          disabled={!loaded}
          testid="stt-engine"
          onChange={(speechToText) => {
            void update({ voiceConfig: { ...voiceConfig, speechToText } }).catch((e: Error) =>
              pushError(failed('settings'), undefined, e.message),
            );
          }}
        />
      </Row>
    </Group>
  );
}

function DictationEnginesGroup(): JSX.Element {
  const dictation = usePreferencesStore((s) => s.preferences.voiceConfig.dictation);
  const voiceConfig = usePreferencesStore((s) => s.preferences.voiceConfig);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const hosts = usePresenceStore((s) => s.hosts);
  const hostReports = Object.values(hosts).flatMap((h) =>
    h.host ? [{ hostName: h.host.hostName, voiceKeys: h.host.voiceKeys }] : [],
  );
  const write = (patch: Partial<DictationConfig>): void => {
    void update({ voiceConfig: { ...voiceConfig, dictation: { ...dictation, ...patch } } }).catch(
      (e: Error) => pushError(failed('settings'), undefined, e.message),
    );
  };
  // A Deepgram choice names each host that holds no key for it.
  const keys = (engine: DictationEngine, testid: string): JSX.Element | undefined => {
    const status = voiceKeyHostStatus(engine, hostReports);
    return status ? (
      <span className="set-sub-line set-sub-error" data-testid={testid}>
        {status}
      </span>
    ) : undefined;
  };
  return (
    <Group label="Dictation" testid="settings-voice-dictation-engines">
      <Row
        title="Phone"
        sub={keys(dictation.phone, 'dictation-phone-keys')}
        testid="dictation-phone"
      >
        <Pills
          label="Phone dictation"
          options={PHONE_DICTATION}
          labels={DICTATION_LABELS}
          value={dictation.phone}
          disabled={!loaded}
          testid="dictation-phone-engine"
          onChange={(phone) => write({ phone })}
        />
      </Row>
      <Row
        title="Computer"
        sub={
          dictation.computer === 'local' ? (
            <LocalSttStatus />
          ) : (
            keys(dictation.computer, 'dictation-computer-keys')
          )
        }
        testid="dictation-computer"
      >
        <Pills
          label="Computer dictation"
          options={COMPUTER_DICTATION}
          labels={DICTATION_LABELS}
          value={dictation.computer}
          disabled={!loaded}
          testid="dictation-computer-engine"
          onChange={(computer) => write({ computer })}
        />
      </Row>
      <Row
        title={`Tidy up each phrase with ${SPEECH_TO_TEXT_LABEL[voiceConfig.speechToText]}`}
        testid="dictation-tidy-row"
      >
        <Toggle
          checked={dictation.tidy}
          disabled={!loaded}
          onChange={(tidy) => write({ tidy })}
          testid="dictation-tidy-toggle"
        />
      </Row>
    </Group>
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
    <Group label="Engine" testid="settings-voice-config">
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

/** How Patch speaks on every host: the engine and its voice, and how often it says the chat's name. */
function SpeakingGroup(): JSX.Element {
  const pushError = useUiStore((s) => s.pushError);
  const kokoroVoice = usePreferencesStore((s) => s.preferences.kokoroVoice);
  const ttsBackend = usePreferencesStore((s) => s.preferences.ttsBackend) ?? 'kokoro';
  const elevenLabsVoice = usePreferencesStore((s) => s.preferences.elevenLabsVoice);
  const chatNameInterval = usePreferencesStore((s) => s.preferences.chatNameInterval);
  const loaded = usePreferencesStore((s) => s.loaded);
  const hosts = usePresenceStore((s) => s.hosts);
  // The account's voices come from whichever online host holds the key.
  const elevenHosts = Object.values(hosts).flatMap((h) => (h.host ? [h.host] : []));
  const elevenVoices = elevenHosts.find((h) => h.elevenLabsVoices !== undefined)?.elevenLabsVoices;
  const elevenError = elevenHosts.find(
    (h) => h.elevenLabsVoicesError !== undefined,
  )?.elevenLabsVoicesError;

  function setNameInterval(raw: string): void {
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 0) {
      pushError('Chat name interval must be a non-negative integer');
      return;
    }
    if (n === chatNameInterval) return;
    void patchShared('chat name interval', { chatNameInterval: n });
  }

  return (
    <Group label="Speaking" testid="voice-speaking">
      <Row title="Speech engine">
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
      ) : (
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
      <Row title="Say the chat name every">
        <input
          type="number"
          min={0}
          className="set-num"
          aria-label="Say the chat name every (replies)"
          data-testid="chat-name-interval"
          key={chatNameInterval}
          defaultValue={chatNameInterval}
          disabled={!loaded}
          onBlur={(e) => setNameInterval(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setNameInterval((e.target as HTMLInputElement).value);
          }}
        />
        <span className="set-unit">replies</span>
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
      data-testid="pair-voice-device-open"
      onClick={() => setPairing(true)}
    >
      Pair a device
    </button>
  );
  return (
    <Group label="Voice devices" testid="settings-voice-devices">
      {voice === null ? (
        <Note>Loading…</Note>
      ) : voice.length === 0 ? (
        <Row title="None paired" testid="voice-devices-empty">
          {pairButton}
        </Row>
      ) : (
        <>
          {voice.map((d) => (
            <DeviceRow key={d.surfaceId} device={d} onRevoke={revoke} />
          ))}
          {pairButton ? <Row title="Pair another">{pairButton}</Row> : null}
        </>
      )}
      {pairing ? (
        <div className="set-row stack">
          <PairVoiceDevice onClose={() => setPairing(false)} />
        </div>
      ) : null}
    </Group>
  );
}
