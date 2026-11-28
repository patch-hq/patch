// Settings → Voice calls → Voice agent (spec/07 § The voice agent, spec/14 §
// Voice): provider, then model, then voice, then how it sounds — each choice
// appearing once the one before it is made. Model and voice lists are what a
// host read from the provider's API (`host.host.voiceCatalog`), with Refresh.

import { useEffect, useRef, useState, type JSX } from 'react';
import { SetupLine } from '../../components/SetupLine.js';
import {
  CATALOG_PROVIDER_LABEL,
  VOICE_AGENT_ENGINES,
  VOICE_AGENT_PROVIDER_LABEL,
  VoiceAgentProvider,
  soundValues,
  voiceCatalogView,
  backendSetupLine,
  voiceToneKey,
  type CatalogItem,
  type CatalogProvider,
  type SliderControl,
  type SoundValue,
  type SoundValues,
  type VoiceCatalogEntry,
  type VoiceCatalogView,
  type VoiceEngine,
} from '@patch/wire/audio';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { Toggle } from '../../components/Toggle.js';
import { patchShared } from './sharedWrite.js';
import { sendToHost } from './hostWrite.js';
import { Group, Pills, Row } from './ui.js';
import { PromptRow } from './PromptRow.js';
import {
  DEFAULT_VOICE_INSTRUCTIONS,
  DEFAULT_VOICE_RELAY_CHAT_REPLY,
  DEFAULT_VOICE_RELAY_FAILURE,
  DEFAULT_VOICE_RELAY_HANDOFF_ANSWER,
  DEFAULT_VOICE_RELAY_UNPROMPTED,
} from '@patch/wire';

const PROVIDERS = VoiceAgentProvider.options;

/** The lists Settings shows for a provider, from whichever host read them. */
export function useVoiceCatalog(provider: CatalogProvider): VoiceCatalogView {
  const hosts = usePresenceStore((s) => s.hosts);
  return voiceCatalogView(
    provider,
    Object.values(hosts).flatMap((h) =>
      h.host
        ? [
            {
              hostName: h.host.hostName,
              online: h.online,
              voiceKeys: h.host.voiceKeys,
              voiceCatalog: h.host.voiceCatalog,
            },
          ]
        : [],
    ),
  );
}

/** Ask every online host holding the provider's key to read its lists again. */
export function refreshVoiceCatalog(provider: CatalogProvider): void {
  const hosts = Object.values(usePresenceStore.getState().hosts).filter(
    (h) => h.online && h.host?.voiceKeys?.[provider] === true,
  );
  if (hosts.length === 0) {
    useUiStore
      .getState()
      .pushError(
        `No online host has a ${CATALOG_PROVIDER_LABEL[provider]} key, so nothing can read its lists.`,
      );
    return;
  }
  for (const h of hosts) {
    sendToHost(h, { type: 'host.voice_catalog_refresh', hostId: h.hostId, provider });
  }
}

/** The line under a list's title: its count and Refresh, or why there is no list. */
export function CatalogLine({
  view,
  provider,
  count,
  noun,
  testid,
}: {
  view: VoiceCatalogView;
  provider: CatalogProvider;
  count: number;
  noun: string;
  testid: string;
}): JSX.Element {
  const name = CATALOG_PROVIDER_LABEL[provider];
  const text =
    view.state === 'ready'
      ? `${count} ${noun}${count === 1 ? '' : 's'}`
      : view.state === 'loading'
        ? `Loading ${noun}s…`
        : view.state === 'failed'
          ? `Could not read ${name}'s ${noun}s: ${view.message}`
          : `Add an API key for ${name} in Settings → Providers to list its ${noun}s.`;
  return (
    <span className="set-sub-line" data-testid={`${testid}-status`}>
      <span className={view.state === 'failed' ? 'set-sub-error' : undefined}>{text}</span>
      {view.state === 'no-key' ? null : (
        <>
          {' · '}
          <button
            type="button"
            className="set-link"
            data-testid={`${testid}-refresh`}
            onClick={() => refreshVoiceCatalog(provider)}
          >
            Refresh
          </button>
        </>
      )}
    </span>
  );
}

/** A choice from a provider's list. A stored id the list no longer has is kept and marked. */
function CatalogSelect({
  label,
  items,
  value,
  placeholder,
  disabled,
  testid,
  onChange,
}: {
  label: string;
  items: CatalogItem[] | undefined;
  value: string | undefined;
  placeholder: string;
  disabled: boolean;
  testid: string;
  onChange: (id: string) => void;
}): JSX.Element {
  const list = items ?? [];
  const missing = value !== undefined && items !== undefined && !list.some((i) => i.id === value);
  return (
    <select
      aria-label={label}
      data-testid={testid}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value !== '') onChange(e.target.value);
      }}
    >
      {value === undefined ? <option value="">{placeholder}</option> : null}
      {value !== undefined && (items === undefined || missing) ? (
        <option value={value}>{missing ? `${value} (no longer offered)` : value}</option>
      ) : null}
      {list.map((i) => (
        <option key={i.id} value={i.id}>
          {i.label}
        </option>
      ))}
    </select>
  );
}

const COMMIT_AFTER_MS = 300;

/** A slider that names its ends and shows its value; writes once it settles. */
export function SoundSlider({
  label,
  value,
  min,
  max,
  step,
  low,
  high,
  format,
  disabled,
  testid,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  low?: string;
  high?: string;
  format: (n: number) => string;
  disabled: boolean;
  testid: string;
  onCommit: (n: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const shown = draft ?? value;
  return (
    <span className="set-slider">
      {low ? <span className="set-unit">{low}</span> : null}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={format(shown)}
        data-testid={testid}
        onChange={(e) => {
          const next = Number(e.target.value);
          setDraft(next);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = null;
            if (next !== value) onCommit(next);
            setDraft(null);
          }, COMMIT_AFTER_MS);
        }}
      />
      {high ? <span className="set-unit">{high}</span> : null}
      <span className="set-val" data-testid={`${testid}-value`}>
        {format(shown)}
      </span>
    </span>
  );
}

/** A slider's value as Settings shows it: `0.7`, `0.95×`. */
export function sliderText(c: SliderControl, n: number): string {
  return `${Math.round(n * 100) / 100}${c.suffix ?? ''}`;
}

/** Tone: raw text kept per voice. Saved when the box loses focus. */
export function ToneRow({
  provider,
  voice,
  testid,
}: {
  provider: string;
  voice: string;
  testid: string;
}): JSX.Element {
  const tones = usePreferencesStore((s) => s.preferences.voiceTones);
  const key = voiceToneKey(provider, voice);
  const saved = tones[key] ?? '';
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  return (
    <Row title="Tone" testid={`${testid}-row`} className="stack set-row-tone">
      <textarea
        aria-label="Tone"
        className="set-tone"
        data-testid={testid}
        rows={2}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === saved) return;
          const next = { ...usePreferencesStore.getState().preferences.voiceTones };
          if (draft.trim() === '') delete next[key];
          else next[key] = draft;
          void patchShared('tone', { voiceTones: next });
        }}
      />
    </Row>
  );
}

/**
 * An engine's "how it sounds" controls, drawn from its description
 * (voiceEngines.ts): the same renderer for every engine. `voice` keys the tone.
 */
export function SoundControls({
  engine,
  stored,
  voice,
  catalog,
  disabled,
  testid,
  onChange,
}: {
  engine: VoiceEngine;
  stored: SoundValues;
  voice: string;
  catalog: VoiceCatalogEntry | undefined;
  disabled: boolean;
  testid: string;
  onChange: (next: SoundValues) => void;
}): JSX.Element {
  const values = soundValues(engine, stored);
  const set = (key: string, v: SoundValue): void => onChange({ ...stored, [key]: v });
  return (
    <>
      {engine.controls.map((c) => {
        const id = `${testid}-${c.key}`;
        if (c.kind === 'tone') {
          return <ToneRow key={c.key} provider={engine.id} voice={voice} testid={id} />;
        }
        if (c.kind === 'toggle') {
          return (
            <Row key={c.key} title={c.label} testid={`${id}-row`}>
              <Toggle
                checked={values[c.key] === true}
                disabled={disabled}
                testid={id}
                onChange={(on) => set(c.key, on)}
              />
            </Row>
          );
        }
        if (c.kind === 'slider') {
          return (
            <Row key={c.key} title={c.label} testid={`${id}-row`}>
              <SoundSlider
                label={c.label}
                value={values[c.key] as number}
                min={c.min}
                max={c.max}
                step={c.step}
                {...(c.low !== undefined ? { low: c.low } : {})}
                {...(c.high !== undefined ? { high: c.high } : {})}
                format={(n) => sliderText(c, n)}
                disabled={disabled}
                testid={id}
                onCommit={(n) => set(c.key, n)}
              />
            </Row>
          );
        }
        if (c.kind === 'choice') {
          return (
            <Row key={c.key} title={c.label} testid={`${id}-row`}>
              <Pills
                label={c.label}
                options={c.options.map((o) => o.id)}
                labels={Object.fromEntries(c.options.map((o) => [o.id, o.label]))}
                value={values[c.key] as string}
                disabled={disabled}
                testid={id}
                onChange={(next) => set(c.key, next)}
              />
            </Row>
          );
        }
        return (
          <Row key={c.key} title={c.label} testid={`${id}-row`}>
            <CatalogSelect
              label={c.label}
              items={catalog?.[c.list]}
              value={values[c.key] as string | undefined}
              placeholder={c.placeholder}
              disabled={disabled || catalog === undefined}
              testid={id}
              onChange={(next) => set(c.key, next)}
            />
          </Row>
        );
      })}
    </>
  );
}

export function VoiceAgentGroup(): JSX.Element {
  const agent = usePreferencesStore((s) => s.preferences.voiceAgent);
  const loaded = usePreferencesStore((s) => s.loaded);
  const hosts = usePresenceStore((s) => s.hosts);
  const provider = agent.provider;
  const view = useVoiceCatalog(provider);
  const entry = view.state === 'ready' ? view.entry : undefined;
  const setup = agent.setups[provider];
  const writeSetup = (next: typeof setup): void =>
    void patchShared('voice agent', {
      voiceAgent: { ...agent, setups: { ...agent.setups, [provider]: next } },
    });
  const keyStatus = backendSetupLine(
    provider,
    Object.values(hosts).flatMap((h) =>
      h.host ? [{ hostName: h.host.hostName, voiceKeys: h.host.voiceKeys }] : [],
    ),
  );
  return (
    <Group label="Voice agent" testid="settings-voice-agent">
      <Row
        title="Provider"
        sub={keyStatus ? <SetupLine text={keyStatus} testid="voice-keys" /> : undefined}
        testid="voice-provider"
      >
        <Pills
          label="Voice agent provider"
          options={PROVIDERS}
          labels={VOICE_AGENT_PROVIDER_LABEL}
          value={provider}
          disabled={!loaded}
          testid="voice-agent-provider"
          onChange={(next) =>
            void patchShared('voice agent', { voiceAgent: { ...agent, provider: next } })
          }
        />
      </Row>
      <Row
        title="Model"
        sub={
          <CatalogLine
            view={view}
            provider={provider}
            count={entry?.models?.length ?? 0}
            noun="model"
            testid="voice-agent-model"
          />
        }
        testid="voice-agent-model-row"
      >
        <CatalogSelect
          label="Model"
          items={entry?.models}
          value={setup.model}
          placeholder="Choose a model"
          disabled={!loaded || entry === undefined}
          testid="voice-agent-model"
          onChange={(model) => writeSetup({ ...setup, model })}
        />
      </Row>
      {setup.model === undefined ? null : (
        <Row title="Voice" testid="voice-agent-voice-row">
          <CatalogSelect
            label="Voice"
            items={entry?.voices}
            value={setup.voice}
            placeholder="Choose a voice"
            disabled={!loaded || entry === undefined}
            testid="voice-agent-voice"
            onChange={(voice) => writeSetup({ ...setup, voice })}
          />
        </Row>
      )}
      {setup.model === undefined || setup.voice === undefined ? null : (
        <>
          <div className="set-row set-row-heading" data-testid="voice-agent-sound">
            <span className="set-sub">How it sounds</span>
          </div>
          <SoundControls
            engine={VOICE_AGENT_ENGINES[provider]}
            stored={setup.sound}
            voice={setup.voice}
            catalog={entry}
            disabled={!loaded}
            testid="voice-agent"
            onChange={(sound) => writeSetup({ ...setup, sound })}
          />
        </>
      )}
      <VoiceInstructionsRow />
      <VoiceRelayRows />
    </Group>
  );
}

/** What the voice agent is told it is (spec/07 § Voice instructions): the user's own text. */
function VoiceInstructionsRow(): JSX.Element {
  const current = usePreferencesStore((s) => s.preferences.voiceInstructions);
  return (
    <PromptRow
      id="voice-instructions"
      title="Voice instructions"
      sub="What the voice agent on a call is told it is. Nothing else is added but its tone and the chat."
      defaultText={DEFAULT_VOICE_INSTRUCTIONS}
      current={current}
      onSave={(text) => patchShared('voice instructions', { voiceInstructions: text })}
      onDefault={() =>
        patchShared('voice instructions', { voiceInstructions: DEFAULT_VOICE_INSTRUCTIONS })
      }
    />
  );
}

const RELAY_ROWS = [
  {
    id: 'voice-relay-handoff-answer',
    title: 'Hand-off answer',
    sub: 'How the voice relays the answer to something it passed on.',
    key: 'voiceRelayHandoffAnswer',
    def: DEFAULT_VOICE_RELAY_HANDOFF_ANSWER,
  },
  {
    id: 'voice-relay-chat-reply',
    title: 'Reply from another chat',
    sub: "How the voice relays another chat's reply to a message it sent.",
    key: 'voiceRelayChatReply',
    def: DEFAULT_VOICE_RELAY_CHAT_REPLY,
  },
  {
    id: 'voice-relay-unprompted',
    title: 'Unprompted message',
    sub: "How the voice relays a message the chat's agent sends on its own.",
    key: 'voiceRelayUnprompted',
    def: DEFAULT_VOICE_RELAY_UNPROMPTED,
  },
  {
    id: 'voice-relay-failure',
    title: 'Failure',
    sub: 'How the voice relays a request or message that failed.',
    key: 'voiceRelayFailure',
    def: DEFAULT_VOICE_RELAY_FAILURE,
  },
] as const;

/** How the voice relays each kind of push (spec/07 § Pushes): the user's own instruction per kind. */
function VoiceRelayRows(): JSX.Element {
  const preferences = usePreferencesStore((s) => s.preferences);
  return (
    <>
      {RELAY_ROWS.map((r) => (
        <PromptRow
          key={r.id}
          id={r.id}
          title={r.title}
          sub={r.sub}
          defaultText={r.def}
          current={preferences[r.key]}
          onSave={(text) => patchShared(r.title, { [r.key]: text })}
          onDefault={() => patchShared(r.title, { [r.key]: r.def })}
        />
      ))}
    </>
  );
}
