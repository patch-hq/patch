// Settings → Voice calls on the phone, at parity with web (spec/15 § Settings
// tab, spec/14 § Voice): the voice agent revealed one choice at a time, its
// sound drawn from the engine description (voiceEngines.ts) by one generic
// renderer, Agents calling you, Calls, and how voice devices answer.

import React from 'react';
import { PanResponder, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  VOICE_AGENT_ENGINES,
  VOICE_AGENT_PROVIDER_LABEL,
  VoiceAgentProvider,
  soundValues,
  voiceCatalogView,
  voiceKeyHostStatus,
  voiceToneKey,
  type CatalogItem,
  type SliderControl,
  type SoundValue,
  type SoundValues,
  type VoiceCatalogEntry,
  type VoiceCatalogView,
  type VoiceEngine,
} from '@patch/wire/audio';
import { PAUSE_WHEN_QUIET_CHOICES } from '@patch/wire';
import type { AccountPreferences } from '../../api/rest';
import { space, typography, useTheme } from '../../lib/theme';
import { usePresenceStore } from '../../stores/presenceStore';
import { OptionPicker } from '../OptionPicker';
import { SettingsSection } from '../SettingsSection';
import { sendToHost } from './hostSend';
import { TextPromptLink } from './PromptRows';
import { patchShared } from './sharedWrite';
import { Chips, Field, Muted, Row, SettingsButton, ToggleRow, WithSettings } from './ui';

/** The lists Settings shows for a provider, from whichever host read them. */
export function useVoiceCatalog(provider: VoiceAgentProvider): VoiceCatalogView {
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
export function refreshVoiceCatalog(provider: VoiceAgentProvider): void {
  for (const h of Object.values(usePresenceStore.getState().hosts)) {
    if (!h.online || h.host?.voiceKeys?.[provider] !== true) continue;
    sendToHost(
      h.hostId,
      { type: 'host.voice_catalog_refresh', hostId: h.hostId, provider },
      'Refresh',
    );
  }
}

function catalogText(
  view: VoiceCatalogView,
  provider: VoiceAgentProvider,
  count: number,
  noun: string,
): string {
  const name = VOICE_AGENT_PROVIDER_LABEL[provider];
  if (view.state === 'ready') return `${count} ${noun}${count === 1 ? '' : 's'}`;
  if (view.state === 'loading') return `Loading ${noun}s…`;
  if (view.state === 'failed') return `Could not read ${name}'s ${noun}s: ${view.message}`;
  return `Add an API key for ${name} in Settings → Providers to list its ${noun}s.`;
}

/** A choice from a provider's list. A stored id the list no longer has is kept and marked. */
function CatalogPicker({
  items,
  value,
  placeholder,
  disabled,
  testID,
  onSelect,
}: {
  items: CatalogItem[] | undefined;
  value: string | undefined;
  placeholder: string;
  disabled: boolean;
  testID: string;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const found = items?.find((i) => i.id === value);
  const label =
    value === undefined
      ? placeholder
      : found
        ? found.label
        : items === undefined
          ? value
          : `${value} (no longer offered)`;
  return (
    <OptionPicker
      testID={testID}
      selectedId={value ?? ''}
      selectedLabel={label}
      options={items ?? []}
      disabled={disabled}
      onSelect={onSelect}
      emptyText="Nothing listed"
    />
  );
}

/** A slider's value as Settings shows it: `0.7`, `0.95×`. */
export function sliderText(c: SliderControl, n: number): string {
  return `${Math.round(n * 100) / 100}${c.suffix ?? ''}`;
}

/** Snap a raw value onto the control's steps and bounds. */
export function snap(c: SliderControl, raw: number): number {
  const stepped = Math.round((raw - c.min) / c.step) * c.step + c.min;
  return Math.round(Math.min(c.max, Math.max(c.min, stepped)) * 1000) / 1000;
}

/**
 * A slider drawn from plain views (no native module, so it ships over the
 * air). Drag or tap the track; an accessibility increment/decrement moves one
 * step. Writes once, when the finger lifts.
 */
export function SoundSlider({
  control,
  value,
  disabled,
  testID,
  onCommit,
}: {
  control: SliderControl;
  value: number;
  disabled: boolean;
  testID: string;
  onCommit: (n: number) => void;
}): React.ReactElement {
  const colors = useTheme();
  const [width, setWidth] = React.useState(0);
  const [draft, setDraft] = React.useState<number | null>(null);
  const shown = draft ?? value;
  const at = (x: number): number =>
    snap(
      control,
      control.min + (Math.max(0, Math.min(width, x)) / (width || 1)) * (control.max - control.min),
    );
  const latest = React.useRef({ at, value, onCommit, disabled });
  latest.current = { at, value, onCommit, disabled };
  const responder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !latest.current.disabled,
        onMoveShouldSetPanResponder: () => !latest.current.disabled,
        onPanResponderGrant: (e) => setDraft(latest.current.at(e.nativeEvent.locationX)),
        onPanResponderMove: (e) => setDraft(latest.current.at(e.nativeEvent.locationX)),
        onPanResponderRelease: (e) => {
          const next = latest.current.at(e.nativeEvent.locationX);
          setDraft(null);
          if (next !== latest.current.value) latest.current.onCommit(next);
        },
        onPanResponderTerminate: () => setDraft(null),
      }),
    [],
  );
  const fraction = (shown - control.min) / (control.max - control.min);
  const step = (dir: 1 | -1): void => {
    const next = snap(control, value + dir * control.step);
    if (next !== value) onCommit(next);
  };
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View
          testID={testID}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={control.label}
          accessibilityValue={{ text: sliderText(control, shown) }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
          onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
          style={{ flex: 1, height: 28, justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}
          {...responder.panHandlers}
        >
          <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.divider }} />
          <View
            style={{
              position: 'absolute',
              left: 0,
              width: `${fraction * 100}%`,
              height: 4,
              borderRadius: 2,
              backgroundColor: colors.leaf,
            }}
          />
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: Math.max(0, fraction * width - 9),
              width: 18,
              height: 18,
              borderRadius: 9,
              backgroundColor: colors.leaf,
            }}
          />
        </View>
        <Text
          testID={`${testID}-value`}
          style={{ ...typography.body, color: colors.ink2, minWidth: 44, textAlign: 'right' }}
        >
          {sliderText(control, shown)}
        </Text>
      </View>
      {control.low || control.high ? (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginRight: 44 + space.md,
          }}
        >
          <Muted>{control.low ?? ''}</Muted>
          <Muted>{control.high ?? ''}</Muted>
        </View>
      ) : null}
    </View>
  );
}

/** Tone: raw text kept per voice. Saved when the field loses focus. */
export function ToneRow({
  engine,
  voice,
  tones,
  testID,
}: {
  engine: string;
  voice: string;
  tones: AccountPreferences['voiceTones'];
  testID: string;
}): React.ReactElement {
  const key = voiceToneKey(engine, voice);
  const saved = tones[key] ?? '';
  const [draft, setDraft] = React.useState(saved);
  React.useEffect(() => setDraft(saved), [saved]);
  return (
    <Row title="Tone" testID={`${testID}-row`} stack>
      <Field
        testID={testID}
        accessibilityLabel="Tone"
        multiline
        value={draft}
        onChangeText={setDraft}
        onBlur={() => {
          if (draft === saved) return;
          const next = { ...tones };
          if (draft.trim() === '') delete next[key];
          else next[key] = draft;
          void patchShared('Tone', { voiceTones: next });
        }}
      />
    </Row>
  );
}

/**
 * An engine's "how it sounds" controls, drawn from its description: the same
 * renderer for every engine. `voice` keys the tone.
 */
export function SoundControls({
  engine,
  stored,
  voice,
  tones,
  catalog,
  disabled,
  testID,
  onChange,
}: {
  engine: VoiceEngine;
  stored: SoundValues;
  voice: string;
  tones: AccountPreferences['voiceTones'];
  catalog: VoiceCatalogEntry | undefined;
  disabled: boolean;
  testID: string;
  onChange: (next: SoundValues) => void;
}): React.ReactElement {
  const values = soundValues(engine, stored);
  const set = (key: string, v: SoundValue): void => onChange({ ...stored, [key]: v });
  return (
    <>
      {engine.controls.map((c) => {
        const id = `${testID}-${c.key}`;
        if (c.kind === 'tone') {
          return <ToneRow key={c.key} engine={engine.id} voice={voice} tones={tones} testID={id} />;
        }
        if (c.kind === 'toggle') {
          return (
            <ToggleRow
              key={c.key}
              label={c.label}
              testID={id}
              value={values[c.key] === true}
              disabled={disabled}
              onChange={(on) => set(c.key, on)}
            />
          );
        }
        if (c.kind === 'slider') {
          return (
            <Row key={c.key} title={c.label} testID={`${id}-row`} stack>
              <SoundSlider
                control={c}
                value={values[c.key] as number}
                disabled={disabled}
                testID={id}
                onCommit={(n) => set(c.key, n)}
              />
            </Row>
          );
        }
        if (c.kind === 'choice') {
          return (
            <Row key={c.key} title={c.label} testID={`${id}-row`} stack>
              <Chips
                options={c.options.map((o) => o.id)}
                selected={values[c.key] as string}
                labelOf={(o) => c.options.find((x) => x.id === o)?.label ?? o}
                disabled={disabled}
                testIDPrefix={id}
                labelPrefix={c.label}
                onSelect={(o) => set(c.key, o)}
              />
            </Row>
          );
        }
        return (
          <Row key={c.key} title={c.label} testID={`${id}-row`} stack>
            <CatalogPicker
              items={catalog?.[c.list]}
              value={values[c.key] as string | undefined}
              placeholder={c.placeholder}
              disabled={disabled || catalog === undefined}
              testID={id}
              onSelect={(v) => set(c.key, v)}
            />
          </Row>
        );
      })}
    </>
  );
}

function VoiceAgentRows({ preferences }: { preferences: AccountPreferences }): React.ReactElement {
  const colors = useTheme();
  const hosts = usePresenceStore((s) => s.hosts);
  const agent = preferences.voiceAgent;
  const provider = agent.provider;
  const view = useVoiceCatalog(provider);
  const entry = view.state === 'ready' ? view.entry : undefined;
  const setup = agent.setups[provider];
  const writeSetup = (next: typeof setup): void =>
    void patchShared('Voice agent', {
      voiceAgent: { ...agent, setups: { ...agent.setups, [provider]: next } },
    });
  const keyStatus = voiceKeyHostStatus(
    provider,
    Object.values(hosts).flatMap((h) =>
      h.host ? [{ hostName: h.host.hostName, voiceKeys: h.host.voiceKeys }] : [],
    ),
  );
  return (
    <>
      <Row
        title="Provider"
        testID="voice-provider"
        subtitle={
          keyStatus ? (
            <Text testID="voice-keys" style={{ ...typography.meta, color: colors.red }}>
              {keyStatus}
            </Text>
          ) : undefined
        }
        stack
      >
        <Chips
          options={VoiceAgentProvider.options}
          selected={provider}
          labelOf={(p) => VOICE_AGENT_PROVIDER_LABEL[p]}
          testIDPrefix="voice-agent-provider"
          labelPrefix="Voice agent provider"
          onSelect={(p) =>
            void patchShared('Voice agent', { voiceAgent: { ...agent, provider: p } })
          }
        />
      </Row>
      <Row
        title="Model"
        testID="voice-agent-model-row"
        subtitle={
          <Text
            testID="voice-agent-model-status"
            style={{
              ...typography.meta,
              color: view.state === 'failed' ? colors.red : colors.ink3,
            }}
          >
            {catalogText(view, provider, entry?.models?.length ?? 0, 'model')}
          </Text>
        }
        stack
      >
        <CatalogPicker
          items={entry?.models}
          value={setup.model}
          placeholder="Choose a model"
          disabled={entry === undefined}
          testID="voice-agent-model"
          onSelect={(model) => writeSetup({ ...setup, model })}
        />
        {view.state === 'no-key' ? null : (
          <SettingsButton
            testID="voice-agent-model-refresh"
            label="Refresh"
            onPress={() => refreshVoiceCatalog(provider)}
          />
        )}
      </Row>
      {setup.model === undefined ? null : (
        <Row title="Voice" testID="voice-agent-voice-row" stack>
          <CatalogPicker
            items={entry?.voices}
            value={setup.voice}
            placeholder="Choose a voice"
            disabled={entry === undefined}
            testID="voice-agent-voice"
            onSelect={(voice) => writeSetup({ ...setup, voice })}
          />
        </Row>
      )}
      {setup.model === undefined || setup.voice === undefined ? null : (
        <>
          <View
            testID="voice-agent-sound"
            style={{
              paddingHorizontal: space.md + 2,
              paddingTop: space.md,
              borderTopWidth: 1,
              borderColor: colors.lineSoft,
            }}
          >
            <Muted>How it sounds</Muted>
          </View>
          <SoundControls
            engine={VOICE_AGENT_ENGINES[provider]}
            stored={setup.sound}
            voice={setup.voice}
            tones={preferences.voiceTones}
            catalog={entry}
            disabled={false}
            testID="voice-agent"
            onChange={(sound) => writeSetup({ ...setup, sound })}
          />
        </>
      )}
      <TextPromptLink layer="voice-instructions" preferences={preferences} />
    </>
  );
}

export function VoiceAgentSection(): React.ReactElement {
  return (
    <SettingsSection title="Voice agent" testID="settings-voice-agent">
      <WithSettings testID="voice-agent">
        {(data) => <VoiceAgentRows preferences={data.preferences} />}
      </WithSettings>
    </SettingsSection>
  );
}

/** Agents calling you (spec/07 § Agent-initiated voice). */
export function AgentsCallingSection(): React.ReactElement {
  return (
    <SettingsSection title="Agents calling you" testID="settings-agents-calling">
      <WithSettings testID="agents-calling">
        {(data) => (
          <>
            <ToggleRow
              label="Agents can call you"
              subtitle="Rings every device"
              testID="agents-can-call"
              value={data.preferences.agentsCanCall}
              onChange={(on) => void patchShared('Agents can call you', { agentsCanCall: on })}
            />
            {data.preferences.agentsCanCall ? (
              <ToggleRow
                label="Answer automatically in hands-free"
                subtitle="Pauses playback while the agent talks"
                testID="agent-call-auto-answer"
                value={data.preferences.agentCallAutoAnswer}
                onChange={(on) =>
                  void patchShared('Answer automatically', { agentCallAutoAnswer: on })
                }
              />
            ) : null}
          </>
        )}
      </WithSettings>
    </SettingsSection>
  );
}

type QuietOption = `${(typeof PAUSE_WHEN_QUIET_CHOICES)[number]}`;
const QUIET_OPTIONS = PAUSE_WHEN_QUIET_CHOICES.map(String) as QuietOption[];

/** Calls (spec/07 § Pause): pause a call nobody has spoken in for a while. */
export function CallsSection(): React.ReactElement {
  return (
    <SettingsSection title="Calls" testID="settings-calls">
      <WithSettings testID="calls">
        {(data) => (
          <Row title="Pause when quiet for" testID="pause-when-quiet-row" stack>
            <Chips
              options={QUIET_OPTIONS}
              selected={String(data.preferences.pauseWhenQuietMinutes) as QuietOption}
              labelOf={(o) => (o === '0' ? 'Off' : `${o} min`)}
              testIDPrefix="pause-when-quiet"
              labelPrefix="Pause when quiet for"
              onSelect={(o) =>
                void patchShared('Pause when quiet', {
                  pauseWhenQuietMinutes: Number(o) as (typeof PAUSE_WHEN_QUIET_CHOICES)[number],
                })
              }
            />
          </Row>
        )}
      </WithSettings>
    </SettingsSection>
  );
}
