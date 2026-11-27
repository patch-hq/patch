// Settings → Voice calls → Direct calls (spec/07 § Direct calls, spec/14 §
// Voice): every linked device in one list, each with its setup in one line,
// opening in place to its steps — speech to text, its model, text to speech,
// its model, voice, then how it sounds. Only the engines the device last
// reported are offered (spec/05 § Speech engines).

import { useState, type JSX } from 'react';
import {
  DIRECT_TTS_ENGINES,
  changeDirectCall,
  directCallSteps,
  kokoroVoiceLabel,
  type DirectCallChange,
  type DirectEngineOption,
  type SpeechEngineReport,
} from '@patch/wire/direct-call';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { patchShared } from './sharedWrite.js';
import { agoLabel } from './hostWrite.js';
import { useDevices } from './DevicesPage.js';
import { Group, Note, Pills, Row } from './ui.js';
import { SoundControls, useVoiceCatalog } from './VoiceAgentGroup.js';

const KIND: Record<string, string> = {
  desktop: 'Desktop app',
  web: 'Browser',
  mobile: 'Android phone',
};

interface Device {
  surfaceId: string;
  surfaceKind: string;
  label: string;
  status: 'online' | 'stale' | 'offline';
  lastHeartbeat: number | null;
  isCurrent: boolean;
  speechEngines?: SpeechEngineReport;
}

function deviceLine(d: Device): string {
  const kind = KIND[d.surfaceKind] ?? d.surfaceKind;
  if (d.isCurrent) return `${kind} · this device`;
  if (d.status === 'online') return `${kind} · online`;
  return `${kind} · seen ${agoLabel(d.lastHeartbeat)}`;
}

const where = (o: DirectEngineOption<string>): string =>
  `${o.label} · ${o.where === 'device' ? 'On device' : 'Cloud'}`;

/** A choice from a list the device reported. A stored one it no longer reports stays shown. */
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
        <option value={value}>{`${labelOf?.(value) ?? value} (not on this device)`}</option>
      ) : null}
      {options.map((o) => (
        <option key={o} value={o}>
          {labelOf?.(o) ?? o}
        </option>
      ))}
    </select>
  );
}

function DeviceSteps({
  device,
  report,
}: {
  device: Device;
  report: SpeechEngineReport;
}): JSX.Element {
  const setups = usePreferencesStore((s) => s.preferences.deviceDirectCall);
  const tones = usePreferencesStore((s) => s.preferences.voiceTones);
  const steps = directCallSteps(report, setups[device.surfaceId], tones);
  const eleven = useVoiceCatalog('elevenlabs');
  const voiceName = (id: string): string =>
    (eleven.state === 'ready' ? eleven.entry.voices?.find((v) => v.id === id)?.label : undefined) ??
    id;
  const id = `direct-${device.surfaceId}`;
  const change = (c: DirectCallChange): void =>
    void patchShared('direct calls', {
      deviceDirectCall: { ...setups, [device.surfaceId]: changeDirectCall(steps, c) },
    });
  const ttsEngine = steps.tts.engine;
  return (
    <>
      {steps.problem ? <Note testid={`${id}-problem`}>{steps.problem}</Note> : null}
      <Row title="Speech to text" testid={`${id}-stt-row`} className="stack set-row-choices">
        <Pills
          label="Speech to text"
          options={steps.stt.options.map((o) => o.engine)}
          labels={Object.fromEntries(steps.stt.options.map((o) => [o.engine, where(o)]))}
          value={steps.stt.engine}
          testid={`${id}-stt`}
          onChange={(engine) => change({ step: 'stt', engine })}
        />
      </Row>
      {steps.stt.engine === undefined ? null : (
        <Row title="Speech to text model" testid={`${id}-stt-model-row`}>
          <ListSelect
            label="Speech to text model"
            options={steps.sttModel.options}
            value={steps.sttModel.value}
            testid={`${id}-stt-model`}
            onChange={(model) => change({ step: 'sttModel', model })}
          />
        </Row>
      )}
      {steps.sttModel.value === undefined ? null : (
        <Row title="Text to speech" testid={`${id}-tts-row`} className="stack set-row-choices">
          <Pills
            label="Text to speech"
            options={steps.tts.options.map((o) => o.engine)}
            labels={Object.fromEntries(steps.tts.options.map((o) => [o.engine, where(o)]))}
            value={ttsEngine}
            testid={`${id}-tts`}
            onChange={(engine) => change({ step: 'tts', engine })}
          />
        </Row>
      )}
      {steps.sttModel.value === undefined || ttsEngine === undefined ? null : (
        <Row title="Text to speech model" testid={`${id}-tts-model-row`}>
          <ListSelect
            label="Text to speech model"
            options={steps.ttsModel.options}
            value={steps.ttsModel.value}
            testid={`${id}-tts-model`}
            onChange={(model) => change({ step: 'ttsModel', model })}
          />
        </Row>
      )}
      {steps.ttsModel.value === undefined || steps.voice.options.length === 0 ? null : (
        <Row title="Voice" testid={`${id}-voice-row`}>
          <ListSelect
            label="Voice"
            options={steps.voice.options}
            value={steps.voice.value}
            labelOf={
              ttsEngine === 'elevenlabs'
                ? voiceName
                : ttsEngine === 'kokoro'
                  ? kokoroVoiceLabel
                  : undefined
            }
            testid={`${id}-voice`}
            onChange={(voice) => change({ step: 'voice', voice })}
          />
        </Row>
      )}
      {ttsEngine === undefined ||
      steps.ttsModel.value === undefined ||
      DIRECT_TTS_ENGINES[ttsEngine].controls.length === 0 ||
      (steps.voice.options.length > 0 && steps.voice.value === undefined) ? null : (
        <>
          <div className="set-row set-row-heading" data-testid={`${id}-sound`}>
            <span className="set-sub">How it sounds</span>
          </div>
          <SoundControls
            engine={DIRECT_TTS_ENGINES[ttsEngine]}
            stored={steps.sound}
            voice={steps.voice.value ?? ''}
            catalog={undefined}
            disabled={false}
            testid={id}
            onChange={(sound) => change({ step: 'sound', sound })}
          />
        </>
      )}
    </>
  );
}

export function DirectCallsGroup(): JSX.Element {
  const { devices } = useDevices();
  const setups = usePreferencesStore((s) => s.preferences.deviceDirectCall);
  const tones = usePreferencesStore((s) => s.preferences.voiceTones);
  const [open, setOpen] = useState<string | null>(null);
  const app = devices?.filter((d) => d.surfaceKind !== 'voice-device') ?? null;
  return (
    <Group label="Direct calls" testid="settings-direct-calls">
      {app === null ? (
        <Note>Loading…</Note>
      ) : (
        app.map((d: Device) => {
          const report = d.speechEngines;
          const summary = report
            ? directCallSteps(report, setups[d.surfaceId], tones).summary
            : 'Not reported yet';
          const isOpen = open === d.surfaceId;
          return (
            <div key={d.surfaceId} data-testid={`direct-${d.surfaceId}`}>
              <Row
                title={d.label || (KIND[d.surfaceKind] ?? d.surfaceKind)}
                sub={deviceLine(d)}
                testid={`direct-${d.surfaceId}-row`}
                onClick={() => setOpen(isOpen ? null : d.surfaceId)}
              >
                <span className="set-val" data-testid={`direct-${d.surfaceId}-summary`}>
                  {summary}
                </span>
                <span className="set-chev">{isOpen ? '⌄' : '›'}</span>
              </Row>
              {isOpen ? (
                report ? (
                  <DeviceSteps device={d} report={report} />
                ) : (
                  <Note testid={`direct-${d.surfaceId}-unreported`}>
                    This device has not reported its speech engines yet.
                  </Note>
                )
              ) : null}
            </div>
          );
        })
      )}
    </Group>
  );
}
