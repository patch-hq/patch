// A direct call on web and desktop (spec/07 § Direct calls): no voice agent and
// no audio session to the host. This device's microphone feeds the shared
// runtime (`@patch/wire/direct-call-runtime`), its words go to the chat as the
// user's voice turns, and the chat agent's reply is read aloud here. The call
// is held on this device only: it is not announced to, or moved between, other
// devices.

import {
  agentWorkingLabel,
  directCallSummary,
  resolveDirectCall,
  type ResolvedDirectCall,
} from '@patch/wire/direct-call';
import {
  newDirectCallMeter,
  reportDirectCallEnd,
  startDirectCall as startRuntime,
  type DirectCall,
  type DirectCallMeter,
  type DirectCallPost,
  type DirectTurnDetector,
} from '@patch/wire/direct-call-runtime';
import { api } from '../../api/rest.js';
import { useChatStore } from '../../stores/chatStore.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { useVoiceStore } from '../../stores/voiceStore.js';
import { isRunning } from '../../stores/types.js';
import type { ChatEventEntry } from '../../stores/chatStore.js';
import { getDesktopBridge } from '../desktopBridge.js';
import { startRecording, type VoiceRecording } from '../voiceRecorder.js';
import { buildSpeechToText, buildTextToSpeech, currentSpeechEngines } from './engines.js';
import { createPcmPlayer, type PcmPlayer } from './pcmPlayer.js';
import { loadSmartTurn, SMART_TURN_LABEL } from './smartTurn.js';
import { playCallSound } from '../callSound.js';

export interface DirectCallDeps {
  recorder?: () => Promise<VoiceRecording>;
  player?: () => PcmPlayer;
  turn?: () => Promise<DirectTurnDetector>;
  post?: DirectCallPost;
}

interface Active {
  chatId: string;
  runtime: DirectCall;
  recording: VoiceRecording | null;
  player: PcmPlayer;
  unsubscribe: () => void;
}

let active: Active | null = null;

/** The newest agent message in a timeline after `afterSeq`. */
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

function lastSeq(list: readonly ChatEventEntry[] | undefined): number {
  return list && list.length > 0 ? list[list.length - 1]!.seq : 0;
}

/**
 * The agent's state and replies, from this surface's own view of the chat.
 * The reply read aloud is the agent's last message once its turn has ended;
 * progress messages written while it works are not read (spec/07).
 */
function followChat(chatId: string, runtime: DirectCall): () => void {
  let baseline = lastSeq(useChatStore.getState().timelines[chatId]);
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
 * Start a direct call on `chatId` from this device. A device with no speech
 * engine, or a setup it cannot run, is refused with the reason and nothing
 * starts (spec/07 § Direct calls).
 */
export async function startDirectCall(chatId: string, deps: DirectCallDeps = {}): Promise<void> {
  // A paused call holds no session (spec/07 § Pause): a new call replaces it.
  if (useVoiceStore.getState().call?.paused != null) {
    endDirectCall();
    useVoiceStore.getState().endCall();
  }
  const voice = useVoiceStore.getState();
  if (voice.call) return; // a call stays on the chat it was started on
  const prefs = usePreferencesStore.getState().preferences;
  const surfaceId = usePresenceStore.getState().surfaceId;
  const resolved = resolveDirectCall(
    await currentSpeechEngines(),
    surfaceId ? prefs.deviceDirectCall[surfaceId] : undefined,
    prefs.voiceTones,
  );
  if (!resolved.ok) {
    useUiStore.getState().pushError(`Cannot call direct: ${resolved.reason}`);
    return;
  }
  voice.endNote();
  voice.startCall(chatId, 'call', { setup: directCallSummary(resolved.call) });
  call = {
    chatId,
    resolved: resolved.call,
    deps,
    startedAt: Date.now(),
    meter: newDirectCallMeter(),
  };
  await openLine(call);
}

/** The call as started: its chat, engines and test seams, kept for a resume. */
interface DirectCallSpec {
  chatId: string;
  resolved: ResolvedDirectCall;
  deps: DirectCallDeps;
  startedAt: number;
  /** What its cloud engines were sent, across pauses, for its cost (spec/07 § Call cost). */
  meter: DirectCallMeter;
}
let call: DirectCallSpec | null = null;

/** Open the line: the microphone, the engines and the chat, for a new or resumed call. */
async function openLine(spec: DirectCallSpec): Promise<void> {
  const { chatId, resolved, deps } = spec;
  const prefs = usePreferencesStore.getState().preferences;
  const player = (deps.player ?? createPcmPlayer)();
  const ctx = {
    chatId,
    post: deps.post ?? api.voiceDirect,
    meter: spec.meter,
    player,
    bridge: getDesktopBridge(),
  };
  // The detector loads in the background; until it has, a pause is checked
  // against the load itself, so a model that will not load is reported naming
  // Smart Turn and the long pause ends the utterance instead.
  const turnLoad = (deps.turn ?? loadSmartTurn)();
  turnLoad.catch(() => undefined);
  const turn: DirectTurnDetector = {
    label: SMART_TURN_LABEL,
    probability: async (pcm) => (await turnLoad).probability(pcm),
  };
  let runtime: DirectCall;
  try {
    runtime = startRuntime(
      { stt: buildSpeechToText(resolved, ctx), tts: buildTextToSpeech(resolved, ctx), turn },
      {
        sendTurn: async (text) => {
          await ctx.post('/api/voice/direct/turn', { chatId, text });
        },
        longPauseMs: prefs.dictationPauseSeconds * 1000,
        detectTurns: prefs.dictationTurnDetection,
      },
      // The agent-working sound follows this status (voiceController's call-sound loops).
      (status) => useVoiceStore.getState().setDirectStatus(status),
    );
  } catch (e) {
    player.close();
    endDirectCall();
    useUiStore.getState().pushError(`Cannot call direct: ${(e as Error).message}`);
    return;
  }
  runtime.setMuted(useVoiceStore.getState().call?.muted === true);
  const a: Active = {
    chatId,
    runtime,
    recording: null,
    player,
    unsubscribe: followChat(chatId, runtime),
  };
  active = a;
  try {
    const rec = await (deps.recorder ?? (() => startRecording({ keepClip: false })))();
    if (active !== a) {
      rec.cancel();
      return;
    }
    a.recording = rec;
    rec.onPcm((pcm) => a.runtime.pushPcm(pcm));
    rec.onLevel((level) => useVoiceStore.getState().setCallLevel(level));
    useVoiceStore.getState().setCallPhase('listening');
    playCallSound('connected');
  } catch (e) {
    endDirectCall();
    useUiStore
      .getState()
      .pushError(`Cannot call direct: the microphone would not open (${(e as Error).message})`);
  }
}

/** Close the line: stop listening and reading, and release the microphone. */
function closeLine(): void {
  const a = active;
  if (!a) return;
  active = null;
  a.unsubscribe();
  a.runtime.end();
  a.recording?.cancel();
  a.player.close();
}

/** Whether a direct call's line is open on this device. */
export function directCallActive(): boolean {
  return active !== null;
}

export function setDirectCallMuted(muted: boolean): void {
  active?.runtime.setMuted(muted);
}

/** Pause (spec/07 § Pause): the line closes, the call stays on the bar to resume. */
export function pauseDirectCall(): void {
  closeLine();
}

/** Resume a paused direct call on the same chat, with the same engines. */
export async function resumeDirectCall(): Promise<void> {
  if (call) await openLine(call);
}

/**
 * Hang up the direct call. The host is told it ended, with what its cloud
 * engines were sent, so it costs it and leaves its line in the chat; a failure
 * to tell it is shown.
 */
export function endDirectCall(): void {
  closeLine();
  if (call === null) return;
  const ended = call;
  call = null;
  useVoiceStore.getState().endCall();
  reportDirectCallEnd({
    post: ended.deps.post ?? api.voiceDirect,
    chatId: ended.chatId,
    startedAt: ended.startedAt,
    call: ended.resolved,
    meter: ended.meter,
  }).catch((e: Error) =>
    useUiStore.getState().pushError(`The call's cost was not recorded: ${e.message}`),
  );
}

/** The bar's status line on a direct call. */
export function directCallLine(
  status: { line: string; workingSince: number | null },
  now: number,
): string {
  switch (status.line) {
    case 'speaking':
      return 'Speaking';
    case 'hearing':
      return 'Hearing you';
    case 'sending':
      return 'Thinking…';
    case 'working':
      return agentWorkingLabel(now - (status.workingSince ?? now));
    default:
      return 'Listening';
  }
}
