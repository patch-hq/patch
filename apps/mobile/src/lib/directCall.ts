// A direct call on the phone (spec/07 § Direct calls): no voice agent and no
// audio session to the host. The phone's microphone feeds the shared runtime
// (`@patch/wire/direct-call-runtime`), its words go to the chat as voice turns,
// and the chat agent's reply is read aloud here. Its engines are the phone's own
// (Android's on-device recogniser and voices, Smart Turn run natively) or the
// account's cloud ones through the chat's host — every one behind the same
// interfaces the web and desktop implement.

import { NativeModules, Platform } from 'react-native';
import { router, type Href } from 'expo-router';
import {
  cloudSpeechEnginesFromHosts,
  directCallSummary,
  mergeSpeechEngines,
  NOT_SET_UP,
  resolveDirectCall,
  CLOUD_STT_ENGINES,
  CLOUD_TTS_ENGINES,
  STT_ENGINE_LABEL,
  TTS_ENGINE_LABEL,
  type CloudSttEngine,
  type CloudTtsEngine,
  type ResolvedDirectCall,
  type SpeechEngineReport,
} from '@patch/wire/direct-call';
import {
  bytesToBase64,
  cloudSpeechToText,
  cloudTextToSpeech,
  newDirectCallMeter,
  reportDirectCallEnd,
  startDirectCall as startRuntime,
  type DirectCall,
  type DirectCallMeter,
  type DirectCallPost,
  type DirectSpeechToText,
  type DirectTextToSpeech,
  type DirectTurnDetector,
  type PreparedSpeech,
} from '@patch/wire/direct-call-runtime';
import { SMART_TURN_MODEL } from '@patch/wire/smart-turn';
import { api } from '../api/rest';
import { apiUrl } from '../config';
import { useChatStore, type ChatEventEntry } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useSettingsStore } from '../stores/settingsStore';
import { isRunning } from '../stores/types';
import { useUiStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { playCallSound } from './callSounds';
import { startMicCapture, stopMicCapture } from './voiceMic';

export interface PatchDirectCallModule {
  deviceEngines(): Promise<{ stt: boolean; voices: string[] }>;
  transcribe(pcmBase64: string, language: string): Promise<string>;
  speak(text: string, voice: string, id: string): Promise<void>;
  stopSpeaking(): Promise<void>;
  playPcm(pcmBase64: string, sampleRate: number): Promise<void>;
  stopPcm(): Promise<void>;
  loadSmartTurn(url: string, sha256: string): Promise<void>;
  turnProbability(pcmBase64: string): Promise<number>;
}

/** The native module; null off Android. A missing module on Android is a broken build. */
export function directCallModule(): PatchDirectCallModule | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as Record<string, unknown>)['PatchDirectCall'];
  if (!mod)
    throw new Error('PatchDirectCall native module missing — this APK predates direct calls');
  return mod as PatchDirectCallModule;
}

const LANGUAGE = 'en-GB';
export const ANDROID_STT_MODEL = 'on-device';
export const ANDROID_TTS_MODEL = 'android-tts';
const SMART_TURN_LABEL = 'Smart Turn';

function pcmToBase64(pcm: Int16Array): string {
  return bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

/** The engines installed on this phone. */
export async function deviceSpeechEngines(
  mod: PatchDirectCallModule | null = directCallModule(),
): Promise<SpeechEngineReport> {
  const report: SpeechEngineReport = { stt: [], tts: [] };
  if (!mod) return report;
  const d = await mod.deviceEngines();
  if (d.stt) report.stt.push({ engine: 'android', where: 'device', models: [ANDROID_STT_MODEL] });
  if (d.voices.length > 0) {
    report.tts.push({
      engine: 'android',
      where: 'device',
      models: [ANDROID_TTS_MODEL],
      voices: d.voices,
    });
  }
  return report;
}

/** Every engine this phone can run now: its own, then the account's cloud ones. */
export async function currentSpeechEngines(
  mod: PatchDirectCallModule | null = directCallModule(),
): Promise<SpeechEngineReport> {
  const hosts = Object.values(usePresenceStore.getState().hosts).flatMap((h) =>
    h.host
      ? [
          {
            hostName: h.host.hostName,
            online: h.online,
            providerKeys: h.host.providerKeys,
            voiceKeys: h.host.voiceKeys,
            voiceCatalog: h.host.voiceCatalog,
          },
        ]
      : [],
  );
  return mergeSpeechEngines(await deviceSpeechEngines(mod), cloudSpeechEnginesFromHosts(hosts));
}

/** Plays a cloud engine's PCM through the phone, one piece at a time. */
function nativePlayer(mod: PatchDirectCallModule) {
  return (pcm: Int16Array, sampleRate: number): PreparedSpeech => {
    let stopped = false;
    return {
      async play() {
        if (!stopped) await mod.playPcm(pcmToBase64(pcm), sampleRate);
      },
      stop() {
        stopped = true;
        void mod.stopPcm();
      },
    };
  };
}

interface BuildContext {
  chatId: string;
  post: DirectCallPost;
  mod: PatchDirectCallModule;
  /** What the call's cloud engines were sent, for its cost. */
  meter: DirectCallMeter;
}

export function buildSpeechToText(call: ResolvedDirectCall, ctx: BuildContext): DirectSpeechToText {
  const { engine, model } = call.stt;
  if ((CLOUD_STT_ENGINES as readonly string[]).includes(engine)) {
    return cloudSpeechToText({
      post: ctx.post,
      chatId: ctx.chatId,
      engine: engine as CloudSttEngine,
      model,
      meter: ctx.meter,
    });
  }
  if (engine === 'android') {
    return {
      label: STT_ENGINE_LABEL.android,
      transcribe: (pcm) => ctx.mod.transcribe(pcmToBase64(pcm), LANGUAGE),
    };
  }
  throw new Error(`${STT_ENGINE_LABEL[engine]} does not run on this phone`);
}

let speechId = 0;

export function buildTextToSpeech(call: ResolvedDirectCall, ctx: BuildContext): DirectTextToSpeech {
  const { engine, model, voice, sound } = call.tts;
  if ((CLOUD_TTS_ENGINES as readonly string[]).includes(engine)) {
    return cloudTextToSpeech({
      post: ctx.post,
      chatId: ctx.chatId,
      engine: engine as CloudTtsEngine,
      model,
      voice: voice!,
      sound,
      meter: ctx.meter,
      play: nativePlayer(ctx.mod),
    });
  }
  if (engine === 'android') {
    return {
      label: TTS_ENGINE_LABEL.android,
      // Android speaks the text itself, so a piece is ready at once.
      async prepare(text) {
        let stopped = false;
        return {
          async play() {
            if (!stopped) await ctx.mod.speak(text, voice!, `direct-${++speechId}`);
          },
          stop() {
            stopped = true;
            void ctx.mod.stopSpeaking();
          },
        };
      },
    };
  }
  throw new Error(`${TTS_ENGINE_LABEL[engine]} does not run on this phone`);
}

/** Smart Turn on the phone, from the model the Patch server serves with the app. */
function nativeTurnDetector(mod: PatchDirectCallModule): DirectTurnDetector {
  const loaded = mod.loadSmartTurn(apiUrl(SMART_TURN_MODEL.path), SMART_TURN_MODEL.sha256);
  loaded.catch(() => undefined);
  return {
    label: SMART_TURN_LABEL,
    async probability(pcm) {
      await loaded;
      return mod.turnProbability(pcmToBase64(pcm));
    },
  };
}

// ---- the call ----

export interface DirectCallDeps {
  mod?: PatchDirectCallModule;
  post?: DirectCallPost;
  mic?: {
    start(onFrame: (pcm: Int16Array) => void, onError: (m: string) => void): Promise<void>;
    stop(): Promise<void>;
  };
  /** The call's foreground service and notification controls (voiceCall.ts). */
  holdAudio?: (chatId: string) => Promise<void>;
  /** Hang the whole call up, service and all (voiceCall.ts `endVoiceCall`). */
  hangUp?: () => Promise<void>;
  /** Open Settings → Voice calls when this phone has a step still to pick (tests stub it). */
  openSetup?: () => void;
}

interface Spec {
  chatId: string;
  resolved: ResolvedDirectCall;
  deps: DirectCallDeps;
  startedAt: number;
  /** What its cloud engines were sent, across pauses, for its cost (spec/07 § Call cost). */
  meter: DirectCallMeter;
}

let call: Spec | null = null;
let line: { runtime: DirectCall; unsubscribe: () => void; deps: DirectCallDeps } | null = null;

function latestReply(
  list: readonly ChatEventEntry[] | undefined,
  afterSeq: number,
): ChatEventEntry | undefined {
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]!;
    if (e.seq <= afterSeq) return undefined;
    if (e.kind === 'message' && e.role === 'assistant' && (e.content ?? '').trim() !== '') return e;
  }
  return undefined;
}

/** The agent's state and its turn-ending reply, from this phone's view of the chat. */
function followChat(chatId: string, runtime: DirectCall): () => void {
  const first = useChatStore.getState().timelines[chatId];
  let baseline = first && first.length > 0 ? first[first.length - 1]!.seq : 0;
  let wasRunning = isRunning(useChatStore.getState().chats[chatId]);
  let replyOwed = false;
  const check = (): void => {
    const s = useChatStore.getState();
    const row = s.chats[chatId];
    const running = isRunning(row);
    runtime.setAgentWorking(running, running ? row?.chatStatus?.since : undefined);
    if (wasRunning && !running) replyOwed = true;
    wasRunning = running;
    if (running || !replyOwed) return;
    const reply = latestReply(s.timelines[chatId], baseline);
    if (!reply) return;
    replyOwed = false;
    baseline = reply.seq;
    runtime.agentReplied(reply.content ?? '');
  };
  check();
  return useChatStore.subscribe(check);
}

/**
 * Start a direct call on `chatId` from this phone. A phone with no speech
 * engine, or a setup it cannot run, is refused with the reason.
 */
export async function startDirectCall(chatId: string, deps: DirectCallDeps = {}): Promise<void> {
  // A paused call holds no session (spec/07 § Pause): a new call replaces it.
  if (useVoiceStore.getState().callPaused !== null) await (deps.hangUp ?? endDirectCall)();
  if (useVoiceStore.getState().activeSession !== null) return;
  const prefs = useSettingsStore.getState().data?.preferences;
  if (!prefs) {
    useUiStore.getState().pushError('Cannot call direct: settings have not loaded yet');
    return;
  }
  const surfaceId = usePresenceStore.getState().surfaceId;
  let report: SpeechEngineReport;
  try {
    report = await currentSpeechEngines(deps.mod ?? directCallModule());
  } catch (e) {
    useUiStore.getState().pushError(`Cannot call direct: ${(e as Error).message}`);
    return;
  }
  const resolved = resolveDirectCall(
    report,
    surfaceId ? prefs.deviceDirectCall[surfaceId] : undefined,
    prefs.voiceTones,
  );
  if (!resolved.ok) {
    // A step with nothing to run on is a pick to make, not a failure: open the
    // place to make it, with this phone's row open (DirectCallsSection).
    if (resolved.reason === NOT_SET_UP) {
      (deps.openSetup ?? (() => router.push('/settings/voice' as Href)))();
      return;
    }
    useUiStore.getState().pushError(`Cannot call direct: ${resolved.reason}`);
    return;
  }
  const store = useVoiceStore.getState();
  store.setActive({ sessionId: '', chatId, audioUrl: '', startedAt: Date.now() });
  store.setCallMode('call');
  store.setCallDirect({
    setup: directCallSummary(resolved.call),
    status: { line: 'listening', workingSince: null, failure: null, pending: 0 },
  });
  call = {
    chatId,
    resolved: resolved.call,
    deps,
    startedAt: Date.now(),
    meter: newDirectCallMeter(),
  };
  await openLine(call);
}

async function openLine(spec: Spec): Promise<void> {
  const { chatId, resolved, deps } = spec;
  const prefs = useSettingsStore.getState().data!.preferences;
  let runtime: DirectCall;
  try {
    const mod = deps.mod ?? directCallModule();
    if (!mod) throw new Error('direct calls run on Android');
    const ctx = { chatId, post: deps.post ?? api.voiceDirect, mod, meter: spec.meter };
    runtime = startRuntime(
      {
        stt: buildSpeechToText(resolved, ctx),
        tts: buildTextToSpeech(resolved, ctx),
        turn: nativeTurnDetector(mod),
      },
      {
        sendTurn: async (text) => {
          await ctx.post('/api/voice/direct/turn', { chatId, text });
        },
        longPauseMs: prefs.dictationPauseSeconds * 1000,
        detectTurns: prefs.dictationTurnDetection,
      },
      (status) => useVoiceStore.getState().setDirectStatus(status),
    );
  } catch (e) {
    useUiStore.getState().pushError(`Cannot call direct: ${(e as Error).message}`);
    await (deps.hangUp ?? endDirectCall)();
    return;
  }
  runtime.setMuted(useVoiceStore.getState().callMuted);
  const mine = { runtime, unsubscribe: followChat(chatId, runtime), deps };
  line = mine;
  const mic = deps.mic ?? { start: startMicCapture, stop: stopMicCapture };
  try {
    await deps.holdAudio?.(chatId);
    await mic.start(
      (pcm) => mine.runtime.pushPcm(pcm),
      (message) => {
        if (line !== mine) return;
        useUiStore.getState().pushError(`direct call: the microphone failed: ${message}`);
        void (deps.hangUp ?? endDirectCall)();
      },
    );
    if (line !== mine) return;
    useVoiceStore.getState().setCallPhase('listening');
    void playCallSound('connected');
  } catch (e) {
    useUiStore
      .getState()
      .pushError(`Cannot call direct: the microphone would not open (${(e as Error).message})`);
    await (deps.hangUp ?? endDirectCall)();
  }
}

/** Close the line: stop listening and reading, and release the microphone. */
async function closeLine(): Promise<void> {
  const l = line;
  if (!l) return;
  line = null;
  l.unsubscribe();
  l.runtime.end();
  await (l.deps.mic?.stop ?? stopMicCapture)().catch(() => undefined);
}

export function directCallActive(): boolean {
  return line !== null;
}

export function setDirectCallMuted(muted: boolean): void {
  line?.runtime.setMuted(muted);
}

/** Pause (spec/07 § Pause): the line closes; the call stays on the strip. */
export function pauseDirectCall(): Promise<void> {
  return closeLine();
}

/** Resume a paused direct call on the same chat, with the same engines. */
export async function resumeDirectCall(): Promise<void> {
  if (call) await openLine(call);
}

/** End the direct call's line; the call itself is cleared by endVoiceCall. */
export async function endDirectCall(): Promise<void> {
  await closeLine();
  if (call === null) return;
  const ended = call;
  call = null;
  useVoiceStore.getState().setCallDirect(null);
  useVoiceStore.getState().setActive(null);
  // The host is told the call ended, with what its cloud engines were sent, so it
  // costs it and leaves its line in the chat (spec/07 § Call cost).
  try {
    await reportDirectCallEnd({
      post: ended.deps.post ?? api.voiceDirect,
      chatId: ended.chatId,
      startedAt: ended.startedAt,
      call: ended.resolved,
      meter: ended.meter,
    });
  } catch (e) {
    useUiStore.getState().pushError(`The call's cost was not recorded: ${(e as Error).message}`);
  }
}
