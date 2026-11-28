// Settings → Voice calls → Direct calls on the phone, at parity with web
// (spec/07 § Direct calls, spec/14 § Voice): one setup for every device. Each
// step is On device (each device runs its own engine) or a cloud engine the
// account has a key for, and nothing is chosen until the user picks it. The
// steps come from the same wire helpers web uses, and how it sounds is the
// shared engine-description renderer.

import React from 'react';
import { Text, View } from 'react-native';
import {
  DIRECT_TTS_ENGINES,
  changeDirectCall,
  directCallSteps,
  listProviderOf,
  type DirectCallChange,
  type DirectSttEngine,
  type DirectTtsEngine,
  type SpeechEngineReport,
} from '@patch/wire/direct-call';
import type { CatalogProvider } from '@patch/wire/audio';
import type { AccountPreferences, LinkedDevice } from '../../api/rest';
import { space, typography, useTheme } from '../../lib/theme';
import { OptionPicker } from '../OptionPicker';
import { SettingsSection } from '../SettingsSection';
import { patchShared } from './sharedWrite';
import { Chips, Muted, Row, RowValue, SettingsButton, WithSettings } from './ui';
import {
  catalogText,
  refreshVoiceCatalog,
  SoundControls,
  useVoiceCatalog,
} from './VoiceAgentSection';

/** A choice from a provider's list. A stored one the list no longer has stays shown. */
function ListPicker({
  options,
  value,
  labelOf = (v) => v,
  testID,
  onSelect,
}: {
  options: string[];
  value: string | undefined;
  labelOf?: (id: string) => string;
  testID: string;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const label =
    value === undefined
      ? 'Choose'
      : options.includes(value)
        ? labelOf(value)
        : `${labelOf(value)} (no longer offered)`;
  return (
    <OptionPicker
      testID={testID}
      selectedId={value ?? ''}
      selectedLabel={label}
      options={options.map((o) => ({ id: o, label: labelOf(o) }))}
      onSelect={onSelect}
      emptyText="Nothing reported"
    />
  );
}

/**
 * A cloud engine's model list as the account's hosts read it from the provider:
 * its count, loading, or why it could not be read. An on-device engine has none.
 */
function ListStatus({
  provider,
  step,
  testID,
}: {
  provider: CatalogProvider;
  step: 'stt' | 'tts';
  testID: string;
}): React.ReactElement {
  const colors = useTheme();
  const view = useVoiceCatalog(provider);
  const entry = view.state === 'ready' ? view.entry : undefined;
  const list = step === 'stt' ? entry?.transcriptionModels : entry?.speechModels;
  return (
    <Text
      testID={`${testID}-status`}
      style={{ ...typography.meta, color: view.state === 'failed' ? colors.red : colors.ink3 }}
    >
      {catalogText(view, provider, list?.length ?? 0, 'model')}
    </Text>
  );
}

function listSubtitle(
  step: 'stt' | 'tts',
  engine: DirectSttEngine | DirectTtsEngine,
  testID: string,
): { subtitle?: React.ReactElement } {
  const provider = listProviderOf(step, engine);
  return provider
    ? { subtitle: <ListStatus provider={provider} step={step} testID={testID} /> }
    : {};
}

/** Read the cloud engine's list again, on every host holding its key. */
function ListRefresh({
  step,
  engine,
  testID,
}: {
  step: 'stt' | 'tts';
  engine: DirectSttEngine | DirectTtsEngine;
  testID: string;
}): React.ReactElement | null {
  const provider = listProviderOf(step, engine);
  return provider ? <ProviderRefresh provider={provider} testID={testID} /> : null;
}

function ProviderRefresh({
  provider,
  testID,
}: {
  provider: CatalogProvider;
  testID: string;
}): React.ReactElement | null {
  const view = useVoiceCatalog(provider);
  if (view.state === 'no-key') return null;
  return (
    <SettingsButton
      testID={`${testID}-refresh`}
      label="Refresh"
      onPress={() => refreshVoiceCatalog(provider)}
    />
  );
}

function Steps({
  report,
  preferences,
}: {
  report: SpeechEngineReport;
  preferences: AccountPreferences;
}): React.ReactElement {
  const colors = useTheme();
  const steps = directCallSteps(report, preferences.directCall, preferences.voiceTones);
  const eleven = useVoiceCatalog('elevenlabs');
  const voiceName = (id: string): string =>
    (eleven.state === 'ready' ? eleven.entry.voices?.find((v) => v.id === id)?.label : undefined) ??
    id;
  const id = 'direct';
  const change = (c: DirectCallChange): void =>
    void patchShared('Direct calls', { directCall: changeDirectCall(steps, c) });
  const stt = steps.stt.engine;
  const tts = steps.tts.engine;
  const sttCloud = stt !== undefined && stt !== 'device';
  const ttsCloud = tts !== undefined && tts !== 'device';
  const sttDone = stt === 'device' || (sttCloud && steps.sttModel.value !== undefined);
  const label = (options: { engine: string; label: string }[]) => (e: string) =>
    options.find((o) => o.engine === e)!.label;
  return (
    <>
      {steps.problem ? (
        <View style={{ paddingHorizontal: space.md + 2, paddingTop: space.sm }}>
          <Muted testID={`${id}-problem`}>{steps.problem}</Muted>
        </View>
      ) : null}
      <Row title="Speech to text" testID={`${id}-stt-row`} stack>
        <Chips
          options={steps.stt.options.map((o) => o.engine)}
          selected={stt}
          labelOf={label(steps.stt.options)}
          testIDPrefix={`${id}-stt`}
          labelPrefix="Speech to text"
          onSelect={(engine) => change({ step: 'stt', engine })}
        />
      </Row>
      {!sttCloud ? null : (
        <Row
          title="Speech to text model"
          testID={`${id}-stt-model-row`}
          {...listSubtitle('stt', stt as DirectSttEngine, `${id}-stt-model`)}
          stack
        >
          <ListPicker
            options={steps.sttModel.options}
            value={steps.sttModel.value}
            testID={`${id}-stt-model`}
            onSelect={(model) => change({ step: 'sttModel', model })}
          />
          <ListRefresh step="stt" engine={stt as DirectSttEngine} testID={`${id}-stt-model`} />
        </Row>
      )}
      {!sttDone ? null : (
        <Row title="Text to speech" testID={`${id}-tts-row`} stack>
          <Chips
            options={steps.tts.options.map((o) => o.engine)}
            selected={tts}
            labelOf={label(steps.tts.options)}
            testIDPrefix={`${id}-tts`}
            labelPrefix="Text to speech"
            onSelect={(engine) => change({ step: 'tts', engine })}
          />
        </Row>
      )}
      {!sttDone || !ttsCloud ? null : (
        <Row
          title="Text to speech model"
          testID={`${id}-tts-model-row`}
          {...listSubtitle('tts', tts as DirectTtsEngine, `${id}-tts-model`)}
          stack
        >
          <ListPicker
            options={steps.ttsModel.options}
            value={steps.ttsModel.value}
            testID={`${id}-tts-model`}
            onSelect={(model) => change({ step: 'ttsModel', model })}
          />
          <ListRefresh step="tts" engine={tts as DirectTtsEngine} testID={`${id}-tts-model`} />
        </Row>
      )}
      {!sttDone || !ttsCloud || steps.ttsModel.value === undefined ? null : (
        <Row title="Voice" testID={`${id}-voice-row`} stack>
          <ListPicker
            options={steps.voice.options}
            value={steps.voice.value}
            {...(tts === 'elevenlabs' ? { labelOf: voiceName } : {})}
            testID={`${id}-voice`}
            onSelect={(voice) => change({ step: 'voice', voice })}
          />
        </Row>
      )}
      {!sttDone ||
      !ttsCloud ||
      steps.voice.value === undefined ||
      DIRECT_TTS_ENGINES[tts as DirectTtsEngine].controls.length === 0 ? null : (
        <>
          <View
            testID={`${id}-sound`}
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
            engine={DIRECT_TTS_ENGINES[tts as DirectTtsEngine]}
            stored={steps.sound}
            voice={steps.voice.value}
            tones={preferences.voiceTones}
            catalog={undefined}
            disabled={false}
            testID={id}
            onChange={(sound) => change({ step: 'sound', sound })}
          />
        </>
      )}
      {sttDone && tts !== undefined ? (
        <Row
          title="On this device"
          testID={`${id}-here-row`}
          right={<RowValue testID={`${id}-summary`}>{steps.summary}</RowValue>}
        />
      ) : null}
    </>
  );
}

/**
 * The one setup, checked against this phone: its own engines and the
 * account's cloud ones, as it last reported them.
 */
function DirectCallRows({
  devices,
  preferences,
}: {
  devices: LinkedDevice[];
  preferences: AccountPreferences;
}): React.ReactElement {
  const report = devices.find((d) => d.isCurrent)?.speechEngines;
  return report ? (
    <Steps report={report} preferences={preferences} />
  ) : (
    <View style={{ paddingHorizontal: space.md + 2, paddingBottom: space.md }}>
      <Muted testID="direct-unreported">This phone has not reported its speech engines yet.</Muted>
    </View>
  );
}

export function DirectCallsSection(): React.ReactElement {
  return (
    <SettingsSection title="Direct calls" testID="settings-direct-calls">
      <WithSettings testID="direct-calls">
        {(data) => <DirectCallRows devices={data.devices} preferences={data.preferences} />}
      </WithSettings>
    </SettingsSection>
  );
}
