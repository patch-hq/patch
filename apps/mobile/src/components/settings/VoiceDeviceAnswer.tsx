// How a voice device's conversation is answered (spec/16): by the account's
// voice agent, or directly, with speech on the chat's host — and, for direct,
// what the host reads replies out with.

import React from 'react';
import { DeviceAnswer } from '@patch/wire/audio';
import { HOST_KOKORO_VOICES, kokoroVoiceLabel } from '@patch/wire/direct-call';
import type { AccountPreferences } from '../../api/rest';
import { usePresenceStore } from '../../stores/presenceStore';
import { OptionPicker } from '../OptionPicker';
import { patchShared } from './sharedWrite';
import { Chips, Row } from './ui';

/** The account's ElevenLabs voices, listed by whichever online host holds the key. */
function ElevenLabsVoiceRow({
  preferences,
}: {
  preferences: AccountPreferences;
}): React.ReactElement {
  const hosts = usePresenceStore((s) => s.hosts);
  const reports = Object.values(hosts).flatMap((h) => (h.host ? [h.host] : []));
  const voices = reports.find((h) => h.elevenLabsVoices !== undefined)?.elevenLabsVoices;
  const error = reports.find((h) => h.elevenLabsVoicesError !== undefined)?.elevenLabsVoicesError;
  const current = preferences.elevenLabsVoice;
  const options = (voices ?? []).map((v) => ({
    id: v.id,
    label:
      v.category === 'generated'
        ? `${v.name} (designed)`
        : v.category && v.category !== 'premade'
          ? `${v.name} (${v.category})`
          : v.name,
  }));
  return (
    <Row
      title="Voice"
      testID="voice-elevenlabs-voice-row"
      subtitle={
        error !== undefined
          ? `Could not list ElevenLabs voices: ${error}`
          : voices === undefined
            ? 'Add an ElevenLabs key under Hosts → Keys to list voices'
            : undefined
      }
      right={
        <OptionPicker
          testID="elevenlabs-voice"
          selectedId={current ?? ''}
          selectedLabel={
            current === undefined ? '—' : (options.find((o) => o.id === current)?.label ?? current)
          }
          options={options}
          disabled={voices === undefined}
          onSelect={(id) => void patchShared('Voice', { elevenLabsVoice: id })}
          emptyText="No voices"
        />
      }
    />
  );
}

/** The host's Kokoro voices, named as people read them. */
export const KOKORO_VOICES: { id: string; label: string }[] = HOST_KOKORO_VOICES.map((id) => ({
  id,
  label: kokoroVoiceLabel(id),
}));

/**
 * A voice device answering directly (spec/16): its words are transcribed on
 * the chat's host, every turn goes to the chat's agent, and the reply is read
 * out on the host by Kokoro or ElevenLabs.
 */
function DeviceDirectRows({
  preferences,
}: {
  preferences: AccountPreferences;
}): React.ReactElement {
  const tts = preferences.ttsBackend ?? 'kokoro';
  const currentVoice = preferences.kokoroVoice;
  return (
    <>
      <Row
        title="Read replies with"
        subtitle="Every turn goes to the chat’s agent; its reply is read out."
        testID="voice-local-tts"
        stack
      >
        <Chips
          options={['kokoro', 'elevenlabs'] as const}
          selected={tts}
          labelOf={(t) => (t === 'kokoro' ? 'Kokoro (free)' : 'ElevenLabs')}
          testIDPrefix="tts-backend"
          labelPrefix="Speech engine"
          onSelect={(t) => void patchShared('Speech engine', { ttsBackend: t })}
        />
      </Row>
      {tts === 'elevenlabs' ? (
        <ElevenLabsVoiceRow preferences={preferences} />
      ) : (
        <Row
          title="Voice"
          testID="voice-settings"
          subtitle={currentVoice === undefined ? 'Each host’s Kokoro default' : undefined}
          right={
            <OptionPicker
              testID="kokoro-voice"
              selectedId={currentVoice ?? ''}
              selectedLabel={
                currentVoice === undefined
                  ? '—'
                  : (KOKORO_VOICES.find((v) => v.id === currentVoice)?.label ?? currentVoice)
              }
              options={KOKORO_VOICES}
              onSelect={(id) => void patchShared('Voice', { kokoroVoice: id })}
              emptyText="No voices"
            />
          }
        />
      )}
    </>
  );
}

/**
 * How a voice device's conversation is answered (spec/16): by the account's
 * voice agent, or directly, with speech on the chat's host.
 */
export function DeviceAnswerRows({
  preferences,
}: {
  preferences: AccountPreferences;
}): React.ReactElement {
  const voiceConfig = preferences.voiceConfig;
  return (
    <>
      <Row title="Answers with" testID="voice-device-answer-row" stack>
        <Chips
          options={DeviceAnswer.options}
          selected={voiceConfig.deviceAnswer}
          labelOf={(a) => (a === 'agent' ? 'Voice agent' : 'Direct')}
          testIDPrefix="voice-device-answer"
          labelPrefix="Voice devices answer with"
          onSelect={(deviceAnswer) =>
            void patchShared('Voice devices', { voiceConfig: { ...voiceConfig, deviceAnswer } })
          }
        />
      </Row>
      {voiceConfig.deviceAnswer === 'direct' ? (
        <DeviceDirectRows preferences={preferences} />
      ) : null}
    </>
  );
}
