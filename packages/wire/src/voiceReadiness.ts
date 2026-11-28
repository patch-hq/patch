// One readiness model for every voice feature (spec/07 § Readiness).
//
// Each feature declares what it needs: a provider key, a speech-to-text engine,
// a text-to-speech engine, an installed on-device engine, the microphone,
// notifications. `gapsFor` checks those needs against what the host and the
// device report. A surface runs it when the user engages with the feature (a
// toggle, a call button, a Settings row) and shows each gap as an invitation
// with a one-step fix; the host runs the same function when it refuses a
// session, so the two can never disagree.
//
// A spoken alert is an announcement: the host's text to speech only. It never
// needs speech to text, and nothing here asks for it.

import type { VoiceKeys } from './audio.js';
import {
  VOICE_BACKEND_KEY_LABEL,
  voiceBackendFor,
  type ConversationSurface,
  type DictationEngine,
  type HostedVoiceBackend,
  type MeetingEngine,
  type SpeechToTextEngine,
  type VoiceBackend,
  type VoiceConfig,
} from './audio.js';
import type { VoiceAgentSetting } from './voiceEngines.js';

/** What a person is trying to use. */
export type VoiceFeature =
  | { feature: 'spoken-alert' }
  | { feature: 'call'; surface: ConversationSurface }
  | { feature: 'dictation'; engine: DictationEngine }
  | { feature: 'meeting'; engine: MeetingEngine };

/** What a feature may need, by what the need is for (which decides the refusal code). */
export type VoiceNeed =
  | {
      kind: 'key';
      provider: HostedVoiceBackend | 'groq';
      role: 'agent' | 'engine' | 'transcribe' | 'speech';
    }
  | {
      kind: 'engine';
      engine: 'whisper' | 'parakeet' | 'kokoro';
      role: 'transcribe' | 'speech';
    }
  | { kind: 'mic' }
  | { kind: 'notifications' };

/** The account settings a feature's needs depend on. */
export interface VoiceSetup {
  config: VoiceConfig;
  agent: VoiceAgentSetting;
  /** The engine that speaks on the host (`host.settings` → `ttsBackend`). */
  ttsBackend: 'kokoro' | 'elevenlabs';
}

/** What one host reports. `localEngines` are the on-device engines it has installed. */
export interface VoiceHostFacts {
  hostName: string;
  voiceKeys: VoiceKeys;
  localEngines: { whisper: boolean; parakeet: boolean; kokoro: boolean };
}

/** What one device reports about itself. A property it does not have is left out. */
export interface VoiceDeviceFacts {
  /** Microphone permission granted. */
  mic?: boolean;
  /** Notification permission granted. */
  notifications?: boolean;
}

/** Where the one-step fix lives. */
export interface SetupTarget {
  page: 'providers' | 'voice' | 'dictation' | 'meetings' | 'hosts';
  /** The row on that page, as `key:<provider>`, `engine:<id>` or `component:<id>`. */
  row: string;
}

export interface VoiceGap {
  need: VoiceNeed;
  /** A calm complete sentence naming what is missing and where. No call to action. */
  message: string;
  /** The refusal code a host gives a session that needs this. */
  code: 'voice_key_missing' | 'whisper_unavailable' | 'kokoro_unavailable' | 'device_not_ready';
  /** The Settings label for the fix, e.g. `Settings → Providers`. */
  where: string;
  fix: SetupTarget | null;
  /** The other engines that would work, for a gap in a choice the person can switch. */
  alternatives: readonly string[];
}

const FEATURE_LABEL = {
  'spoken-alert': 'Spoken alerts need',
  call: 'Calls need',
  'hands-free': 'Hands-free needs',
  device: 'Voice devices need',
  dictation: 'Dictation needs',
  meeting: 'Meetings need',
} as const;

function featureLabel(f: VoiceFeature): string {
  if (f.feature === 'call') return FEATURE_LABEL[f.surface];
  return FEATURE_LABEL[f.feature];
}

function speechNeeds(setup: VoiceSetup): VoiceNeed[] {
  return setup.ttsBackend === 'elevenlabs'
    ? [{ kind: 'key', provider: 'elevenlabs', role: 'speech' }]
    : [{ kind: 'engine', engine: 'kokoro', role: 'speech' }];
}

function transcribeNeeds(engine: SpeechToTextEngine): VoiceNeed[] {
  if (engine === 'groq') return [{ kind: 'key', provider: 'groq', role: 'transcribe' }];
  if (engine === 'elevenlabs') return [{ kind: 'key', provider: 'elevenlabs', role: 'transcribe' }];
  return [{ kind: 'engine', engine, role: 'transcribe' }];
}

/** What a feature needs, from the account's settings alone. */
export function needsFor(f: VoiceFeature, setup: VoiceSetup): VoiceNeed[] {
  switch (f.feature) {
    // An announcement: the host's text to speech. No microphone, no speech to text.
    case 'spoken-alert':
      return speechNeeds(setup);
    case 'call': {
      const backend: VoiceBackend = voiceBackendFor(setup.config, setup.agent, f.surface);
      const needs: VoiceNeed[] =
        backend === 'local'
          ? [...transcribeNeeds(setup.config.speechToText), ...speechNeeds(setup)]
          : [{ kind: 'key', provider: backend, role: 'agent' }];
      return [...needs, { kind: 'mic' }, { kind: 'notifications' }];
    }
    case 'dictation':
      return [
        ...(f.engine === 'deepgram' || f.engine === 'elevenlabs'
          ? ([{ kind: 'key', provider: f.engine, role: 'engine' }] as VoiceNeed[])
          : []),
        // The tidy-up reads each finished phrase again with the account's speech to text.
        ...(f.engine === 'deepgram' && setup.config.dictation.tidy
          ? transcribeNeeds(setup.config.speechToText)
          : []),
        { kind: 'mic' },
      ];
    case 'meeting':
      return f.engine === 'local' ? [] : [{ kind: 'key', provider: f.engine, role: 'engine' }];
  }
}

const withArticle = (label: string): string => `${/^[AEIOU]/.test(label) ? 'an' : 'a'} ${label}`;

function keyLabel(provider: HostedVoiceBackend | 'groq'): string {
  return provider === 'groq' ? 'Groq key' : VOICE_BACKEND_KEY_LABEL[provider];
}

const ENGINE_LABEL = {
  whisper: 'Whisper',
  parakeet: 'Parakeet',
  kokoro: 'a speech voice',
} as const;

/** The engines (for a switchable choice) that have no gap on this host. */
function workingTranscribers(host: VoiceHostFacts): string[] {
  return (['groq', 'whisper', 'parakeet', 'elevenlabs'] as const).filter((e) =>
    transcribeNeeds(e).every((n) => needMet(n, host, {}) === null),
  );
}

/** Null when met, else why not as `[what is missing, where to fix it, target]`. */
function needMet(
  need: VoiceNeed,
  host: VoiceHostFacts,
  device: VoiceDeviceFacts,
): { missing: string; where: string; fix: SetupTarget | null } | null {
  switch (need.kind) {
    case 'key':
      return host.voiceKeys[need.provider] === true
        ? null
        : {
            missing: `${withArticle(keyLabel(need.provider))} on ${host.hostName}`,
            where: 'Settings → Providers',
            fix: { page: 'providers', row: `key:${need.provider}` },
          };
    case 'engine':
      return host.localEngines[need.engine]
        ? null
        : {
            missing: `${ENGINE_LABEL[need.engine]} on ${host.hostName}`,
            where: 'Settings → Hosts → Components',
            fix: { page: 'hosts', row: `component:${need.engine}` },
          };
    case 'mic':
      return device.mic === false
        ? {
            missing: 'microphone access on this device',
            where: 'this device’s settings',
            fix: null,
          }
        : null;
    case 'notifications':
      return device.notifications === false
        ? {
            missing: 'notification access on this device',
            where: 'this device’s settings',
            fix: null,
          }
        : null;
  }
}

function codeFor(need: VoiceNeed): VoiceGap['code'] {
  if (need.kind === 'mic' || need.kind === 'notifications') return 'device_not_ready';
  if (need.role === 'transcribe') return 'whisper_unavailable';
  if (need.role === 'speech' && need.kind === 'engine') return 'kokoro_unavailable';
  return 'voice_key_missing';
}

function gapOf(
  f: VoiceFeature,
  setup: VoiceSetup | null,
  need: VoiceNeed,
  host: VoiceHostFacts,
  unmet: { missing: string; where: string; fix: SetupTarget | null },
): VoiceGap {
  return {
    need,
    message: `${featureLabel(f)} ${unmet.missing}.`,
    code: codeFor(need),
    where: unmet.where,
    fix: unmet.fix,
    alternatives:
      setup !== null &&
      (need.kind === 'key' || need.kind === 'engine') &&
      need.role === 'transcribe'
        ? workingTranscribers(host).filter((e) => e !== setup.config.speechToText)
        : [],
  };
}

/** Every need of `f` that this host and device cannot meet now, in order. Empty: ready. */
export function gapsFor(
  f: VoiceFeature,
  setup: VoiceSetup,
  host: VoiceHostFacts,
  device: VoiceDeviceFacts = {},
): VoiceGap[] {
  const gaps: VoiceGap[] = [];
  for (const need of needsFor(f, setup)) {
    const unmet = needMet(need, host, device);
    if (unmet !== null) gaps.push(gapOf(f, setup, need, host, unmet));
  }
  return gaps;
}

/** The gap for a provider key a host has just found it does not hold (a clip refused mid-route). */
export function keyMissingGap(
  f: VoiceFeature,
  provider: HostedVoiceBackend | 'groq',
  hostName: string,
): VoiceGap {
  const need: VoiceNeed = {
    kind: 'key',
    provider,
    role: f.feature === 'call' ? 'agent' : 'engine',
  };
  const absent: VoiceHostFacts = {
    hostName,
    voiceKeys: { gemini: false, openai: false, groq: false },
    localEngines: { whisper: false, parakeet: false, kokoro: false },
  };
  const unmet = needMet(need, absent, {});
  if (unmet === null) throw new Error('a missing key is always unmet');
  return gapOf(f, null, need, absent, unmet);
}

/**
 * What the host tells a session it refuses: the gap's sentence and where to
 * fix it. A surface shows the same gap as an invitation.
 */
export function refusalMessage(gap: VoiceGap): string {
  return `${gap.message} Set it up in ${gap.where}.`;
}

/** The features Settings and the host log care about, for the whole account setup. */
export function setupFeatures(setup: VoiceSetup): VoiceFeature[] {
  return [
    { feature: 'spoken-alert' },
    { feature: 'call', surface: 'call' },
    { feature: 'call', surface: 'hands-free' },
    { feature: 'call', surface: 'device' },
    { feature: 'dictation', engine: setup.config.dictation.phone },
    { feature: 'dictation', engine: setup.config.dictation.computer },
    { feature: 'meeting', engine: setup.config.meeting },
  ];
}

/** The host's own needs only (no device): what the boot log lists as unable to run. */
export function hostGaps(
  setup: VoiceSetup,
  host: VoiceHostFacts,
): Array<{ feature: VoiceFeature; gap: VoiceGap }> {
  return setupFeatures(setup).flatMap((feature) =>
    gapsFor(feature, setup, host).map((gap) => ({ feature, gap })),
  );
}

/** A Settings row for a choice: what is missing on which hosts, or null when every reporting host can. */
export function engineSetupLine(
  need: VoiceNeed,
  hosts: ReadonlyArray<{ hostName: string; voiceKeys?: VoiceKeys | undefined }>,
): string | null {
  if (need.kind !== 'key') return null;
  const missing = hosts.filter(
    (h) => h.voiceKeys !== undefined && h.voiceKeys[need.provider] !== true,
  );
  if (missing.length === 0) return null;
  return `Needs ${withArticle(keyLabel(need.provider))} on ${missing.map((h) => h.hostName).join(', ')}.`;
}

/** The needs of a Settings choice of backend, for `engineSetupLine`. */
export function backendNeed(
  backend: VoiceBackend | DictationEngine | MeetingEngine | SpeechToTextEngine,
): VoiceNeed | null {
  if (
    backend === 'local' ||
    backend === 'device' ||
    backend === 'host' ||
    backend === 'whisper' ||
    backend === 'parakeet'
  ) {
    return null;
  }
  return { kind: 'key', provider: backend, role: 'agent' };
}

/** What a host's `host.host` says about speech, as a surface holds it. */
export interface ReportedVoiceHost {
  hostName: string;
  voiceKeys: VoiceKeys;
  voiceLocal: VoiceHostFacts['localEngines'];
  ttsBackend?: 'kokoro' | 'elevenlabs' | undefined;
}

/**
 * The first thing missing for `feature` on any of the hosts that could run it,
 * or null when each can. What a surface asks when the user engages with a
 * feature; the host asks the same question of itself in `gapsFor`.
 */
export function firstGap(
  feature: VoiceFeature,
  account: Pick<VoiceSetup, 'config' | 'agent'>,
  hosts: ReadonlyArray<ReportedVoiceHost>,
  device: VoiceDeviceFacts = {},
): VoiceGap | null {
  for (const h of hosts) {
    const [gap] = gapsFor(
      feature,
      { ...account, ttsBackend: h.ttsBackend ?? 'kokoro' },
      { hostName: h.hostName, voiceKeys: h.voiceKeys, localEngines: h.voiceLocal },
      device,
    );
    if (gap !== undefined) return gap;
  }
  return null;
}

/** Settings' line under a choice of backend or engine: what it lacks on which hosts, or null. */
export function backendSetupLine(
  backend: VoiceBackend | DictationEngine | MeetingEngine | SpeechToTextEngine,
  hosts: ReadonlyArray<{ hostName: string; voiceKeys?: VoiceKeys | undefined }>,
): string | null {
  const need = backendNeed(backend);
  return need === null ? null : engineSetupLine(need, hosts);
}
