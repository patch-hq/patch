// Settings → Voice calls → Direct calls (spec/07 § Direct calls, spec/14 §
// Voice): one setup for every device — speech to text, its model, text to
// speech, its model, voice, then how it sounds. Each step is On device (each
// device runs its own engine) or a cloud engine the account has a key for.
// Nothing is chosen until the user picks it.

import { type JSX } from 'react';
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
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { patchShared } from './sharedWrite.js';
import { useDevices } from './DevicesPage.js';
import { Group, Note, Pills, Row } from './ui.js';
import { CatalogLine, SoundControls, useVoiceCatalog } from './VoiceAgentGroup.js';

/** A choice from a provider's list. A stored one the list no longer has stays shown. */
function ListSelect({
  label,
  options,
  value,
  labelOf,
  testid,
  onChange,
}: {
  label: string;
  options: string[];
  value: string | undefined;
  labelOf?: (id: string) => string;
  testid: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <select
      aria-label={label}
      data-testid={testid}
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value !== '') onChange(e.target.value);
      }}
    >
      {value === undefined ? <option value="">Choose</option> : null}
      {value !== undefined && !options.includes(value) ? (
        <option value={value}>{`${labelOf?.(value) ?? value} (no longer offered)`}</option>
      ) : null}
      {options.map((o) => (
        <option key={o} value={o}>
          {labelOf?.(o) ?? o}
        </option>
      ))}
    </select>
  );
}

/**
 * A cloud engine's model list as the account's hosts read it from the provider:
 * its count, loading, or why it could not be read, with Refresh. An on-device
 * engine has none.
 */
function ListLine({
  step,
  engine,
  testid,
}: {
  step: 'stt' | 'tts';
  engine: DirectSttEngine | DirectTtsEngine;
  testid: string;
}): JSX.Element | null {
  const provider = listProviderOf(step, engine);
  return provider ? <ProviderListLine provider={provider} step={step} testid={testid} /> : null;
}

function ProviderListLine({
  provider,
  step,
  testid,
}: {
  provider: CatalogProvider;
  step: 'stt' | 'tts';
  testid: string;
}): JSX.Element {
  const view = useVoiceCatalog(provider);
  const entry = view.state === 'ready' ? view.entry : undefined;
  const list = step === 'stt' ? entry?.transcriptionModels : entry?.speechModels;
  return (
    <CatalogLine
      view={view}
      provider={provider}
      count={list?.length ?? 0}
      noun="model"
      testid={testid}
    />
  );
}

function Steps({ report }: { report: SpeechEngineReport }): JSX.Element {
  const setup = usePreferencesStore((s) => s.preferences.directCall);
  const tones = usePreferencesStore((s) => s.preferences.voiceTones);
  const steps = directCallSteps(report, setup, tones);
  const eleven = useVoiceCatalog('elevenlabs');
  const voiceName = (id: string): string =>
    (eleven.state === 'ready' ? eleven.entry.voices?.find((v) => v.id === id)?.label : undefined) ??
    id;
  const id = 'direct';
  const change = (c: DirectCallChange): void =>
    void patchShared('direct calls', { directCall: changeDirectCall(steps, c) });
  const sttEngine = steps.stt.engine;
  const ttsEngine = steps.tts.engine;
  const sttCloud = sttEngine !== undefined && sttEngine !== 'device';
  const ttsCloud = ttsEngine !== undefined && ttsEngine !== 'device';
  const sttDone = sttEngine === 'device' || (sttCloud && steps.sttModel.value !== undefined);
  return (
    <>
      {steps.problem ? <Note testid={`${id}-problem`}>{steps.problem}</Note> : null}
      <Row title="Speech to text" testid={`${id}-stt-row`} className="stack set-row-choices">
        <Pills
          label="Speech to text"
          options={steps.stt.options.map((o) => o.engine)}
          labels={Object.fromEntries(steps.stt.options.map((o) => [o.engine, o.label]))}
          value={sttEngine}
          testid={`${id}-stt`}
          onChange={(engine) => change({ step: 'stt', engine })}
        />
      </Row>
      {!sttCloud ? null : (
        <Row
          title="Speech to text model"
          sub={
            <ListLine step="stt" engine={sttEngine as DirectSttEngine} testid={`${id}-stt-model`} />
          }
          testid={`${id}-stt-model-row`}
        >
          <ListSelect
            label="Speech to text model"
            options={steps.sttModel.options}
            value={steps.sttModel.value}
            testid={`${id}-stt-model`}
            onChange={(model) => change({ step: 'sttModel', model })}
          />
        </Row>
      )}
      {!sttDone ? null : (
        <Row title="Text to speech" testid={`${id}-tts-row`} className="stack set-row-choices">
          <Pills
            label="Text to speech"
            options={steps.tts.options.map((o) => o.engine)}
            labels={Object.fromEntries(steps.tts.options.map((o) => [o.engine, o.label]))}
            value={ttsEngine}
            testid={`${id}-tts`}
            onChange={(engine) => change({ step: 'tts', engine })}
          />
        </Row>
      )}
      {!sttDone || !ttsCloud ? null : (
        <Row
          title="Text to speech model"
          sub={
            <ListLine step="tts" engine={ttsEngine as DirectTtsEngine} testid={`${id}-tts-model`} />
          }
          testid={`${id}-tts-model-row`}
        >
          <ListSelect
            label="Text to speech model"
            options={steps.ttsModel.options}
            value={steps.ttsModel.value}
            testid={`${id}-tts-model`}
            onChange={(model) => change({ step: 'ttsModel', model })}
          />
        </Row>
      )}
      {!sttDone || !ttsCloud || steps.ttsModel.value === undefined ? null : (
        <Row title="Voice" testid={`${id}-voice-row`}>
          <ListSelect
            label="Voice"
            options={steps.voice.options}
            value={steps.voice.value}
            labelOf={ttsEngine === 'elevenlabs' ? voiceName : undefined}
            testid={`${id}-voice`}
            onChange={(voice) => change({ step: 'voice', voice })}
          />
        </Row>
      )}
      {!sttDone ||
      !ttsCloud ||
      steps.voice.value === undefined ||
      DIRECT_TTS_ENGINES[ttsEngine as DirectTtsEngine].controls.length === 0 ? null : (
        <>
          <div className="set-row set-row-heading" data-testid={`${id}-sound`}>
            <span className="set-sub">How it sounds</span>
          </div>
          <SoundControls
            engine={DIRECT_TTS_ENGINES[ttsEngine as DirectTtsEngine]}
            stored={steps.sound}
            voice={steps.voice.value}
            catalog={undefined}
            disabled={false}
            testid={id}
            onChange={(sound) => change({ step: 'sound', sound })}
          />
        </>
      )}
      {sttDone && ttsEngine !== undefined ? (
        <Row title="On this device" testid={`${id}-here-row`}>
          <span className="set-val" data-testid={`${id}-summary`}>
            {steps.summary}
          </span>
        </Row>
      ) : null}
    </>
  );
}

/**
 * The one setup, checked against the device Settings is open on: its own
 * engines and the account's cloud ones, as it last reported them.
 */
export function DirectCallsGroup(): JSX.Element {
  const { devices } = useDevices();
  const report = devices?.find((d) => d.isCurrent)?.speechEngines;
  return (
    <Group label="Direct calls" testid="settings-direct-calls">
      {devices === null ? (
        <Note>Loading…</Note>
      ) : report ? (
        <Steps report={report} />
      ) : (
        <Note testid="direct-unreported">This device has not reported its speech engines yet.</Note>
      )}
    </Group>
  );
}
