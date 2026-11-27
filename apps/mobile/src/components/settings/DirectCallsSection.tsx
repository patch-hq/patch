// Settings → Voice calls → Direct calls on the phone, at parity with web
// (spec/07 § Direct calls, spec/14 § Voice): every linked device in one list,
// each with its setup in one line, opening in place to its steps. Only the
// engines the device last reported are offered (spec/05 § Speech engines). The
// steps come from the same wire helpers web uses, and how it sounds is the
// shared engine-description renderer.

import React from 'react';
import { View } from 'react-native';
import {
  DIRECT_TTS_ENGINES,
  changeDirectCall,
  directCallSteps,
  kokoroVoiceLabel,
  type DirectCallChange,
  type DirectEngineOption,
  type SpeechEngineReport,
} from '@patch/wire/direct-call';
import type { AccountPreferences, LinkedDevice } from '../../api/rest';
import { friendlyDeviceName } from '../../lib/labels';
import { space, useTheme } from '../../lib/theme';
import { OptionPicker } from '../OptionPicker';
import { SettingsSection } from '../SettingsSection';
import { deviceSubtitle } from './DevicesSections';
import { patchShared } from './sharedWrite';
import { Chevron, Chips, Muted, Row, RowValue, WithSettings } from './ui';
import { SoundControls, useVoiceCatalog } from './VoiceAgentSection';

const where = (o: DirectEngineOption<string>): string =>
  `${o.label} · ${o.where === 'device' ? 'On device' : 'Cloud'}`;

/** A choice from a list the device reported. A stored one it no longer reports stays shown. */
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
        : `${labelOf(value)} (not on this device)`;
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

function DeviceSteps({
  device,
  report,
  preferences,
}: {
  device: LinkedDevice;
  report: SpeechEngineReport;
  preferences: AccountPreferences;
}): React.ReactElement {
  const colors = useTheme();
  const setups = preferences.deviceDirectCall;
  const steps = directCallSteps(report, setups[device.surfaceId], preferences.voiceTones);
  const eleven = useVoiceCatalog('elevenlabs');
  const voiceName = (id: string): string =>
    (eleven.state === 'ready' ? eleven.entry.voices?.find((v) => v.id === id)?.label : undefined) ??
    id;
  const id = `direct-${device.surfaceId}`;
  const change = (c: DirectCallChange): void =>
    void patchShared('Direct calls', {
      deviceDirectCall: { ...setups, [device.surfaceId]: changeDirectCall(steps, c) },
    });
  const tts = steps.tts.engine;
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
          selected={steps.stt.engine}
          labelOf={(e) => where(steps.stt.options.find((o) => o.engine === e)!)}
          testIDPrefix={`${id}-stt`}
          labelPrefix="Speech to text"
          onSelect={(engine) => change({ step: 'stt', engine })}
        />
      </Row>
      {steps.stt.engine === undefined ? null : (
        <Row title="Speech to text model" testID={`${id}-stt-model-row`} stack>
          <ListPicker
            options={steps.sttModel.options}
            value={steps.sttModel.value}
            testID={`${id}-stt-model`}
            onSelect={(model) => change({ step: 'sttModel', model })}
          />
        </Row>
      )}
      {steps.sttModel.value === undefined ? null : (
        <Row title="Text to speech" testID={`${id}-tts-row`} stack>
          <Chips
            options={steps.tts.options.map((o) => o.engine)}
            selected={tts}
            labelOf={(e) => where(steps.tts.options.find((o) => o.engine === e)!)}
            testIDPrefix={`${id}-tts`}
            labelPrefix="Text to speech"
            onSelect={(engine) => change({ step: 'tts', engine })}
          />
        </Row>
      )}
      {steps.sttModel.value === undefined || tts === undefined ? null : (
        <Row title="Text to speech model" testID={`${id}-tts-model-row`} stack>
          <ListPicker
            options={steps.ttsModel.options}
            value={steps.ttsModel.value}
            testID={`${id}-tts-model`}
            onSelect={(model) => change({ step: 'ttsModel', model })}
          />
        </Row>
      )}
      {steps.ttsModel.value === undefined || steps.voice.options.length === 0 ? null : (
        <Row title="Voice" testID={`${id}-voice-row`} stack>
          <ListPicker
            options={steps.voice.options}
            value={steps.voice.value}
            {...(tts === 'elevenlabs'
              ? { labelOf: voiceName }
              : tts === 'kokoro'
                ? { labelOf: kokoroVoiceLabel }
                : {})}
            testID={`${id}-voice`}
            onSelect={(voice) => change({ step: 'voice', voice })}
          />
        </Row>
      )}
      {tts === undefined ||
      steps.ttsModel.value === undefined ||
      DIRECT_TTS_ENGINES[tts].controls.length === 0 ||
      (steps.voice.options.length > 0 && steps.voice.value === undefined) ? null : (
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
            engine={DIRECT_TTS_ENGINES[tts]}
            stored={steps.sound}
            voice={steps.voice.value ?? ''}
            tones={preferences.voiceTones}
            catalog={undefined}
            disabled={false}
            testID={id}
            onChange={(sound) => change({ step: 'sound', sound })}
          />
        </>
      )}
    </>
  );
}

function DirectCallRows({
  devices,
  preferences,
}: {
  devices: LinkedDevice[];
  preferences: AccountPreferences;
}): React.ReactElement {
  const [open, setOpen] = React.useState<string | null>(null);
  return (
    <>
      {devices
        .filter((d) => d.surfaceKind !== 'voice-device')
        .map((d) => {
          const report = d.speechEngines;
          const summary = report
            ? directCallSteps(
                report,
                preferences.deviceDirectCall[d.surfaceId],
                preferences.voiceTones,
              ).summary
            : 'Not reported yet';
          const isOpen = open === d.surfaceId;
          return (
            <View key={d.surfaceId} testID={`direct-${d.surfaceId}`}>
              <Row
                title={friendlyDeviceName(d.surfaceKind, d.label)}
                subtitle={deviceSubtitle(d)}
                testID={`direct-${d.surfaceId}-row`}
                onPress={() => setOpen(isOpen ? null : d.surfaceId)}
                right={
                  <>
                    <RowValue testID={`direct-${d.surfaceId}-summary`}>{summary}</RowValue>
                    <Chevron />
                  </>
                }
              />
              {isOpen ? (
                report ? (
                  <DeviceSteps device={d} report={report} preferences={preferences} />
                ) : (
                  <View style={{ paddingHorizontal: space.md + 2, paddingBottom: space.md }}>
                    <Muted testID={`direct-${d.surfaceId}-unreported`}>
                      This device has not reported its speech engines yet.
                    </Muted>
                  </View>
                )
              ) : null}
            </View>
          );
        })}
    </>
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
