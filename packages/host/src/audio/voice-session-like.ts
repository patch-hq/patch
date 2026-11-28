// Shared narrow interface between the two voice-session implementations
// (group: native voice tier).
//
// `VoiceSession` (session.ts, the fallback tier: Whisper → agent → Kokoro) and
// `GeminiLiveSession` (gemini-live.ts, the native tier: hosted speech-to-speech)
// are otherwise unrelated classes — different backends, different protocols,
// different internal state machines. `audio/server.ts` needs to hold either
// one polymorphically per open WSS connection without caring which tier a
// session is running, so this is the exact surface it calls through. Both
// classes satisfy it structurally; `VoiceSession` additionally declares
// `implements VoiceSessionLike` so a signature drift is caught at compile
// time rather than only at the call site in server.ts.

import type { AudioSessionMode } from '@patch/wire/audio';
import type { SessionState } from './session.js';
import type { EngineCosting } from './voiceCost.js';

/**
 * spec/07 § Keeping voice and text as one conversation — how a fast voice
 * writes its exchanges into the chat's timeline. Bound to one session (its
 * surface kind is already known to whoever built it).
 */
export interface VoiceTimeline {
  /** The user's finished utterance, as their message on `chatId`. */
  userSaid(chatId: string, text: string): void;
  /** Start the fast voice's reply on `chatId`, streamed as it is spoken. */
  beginReply(chatId: string): VoiceReplyWriter;
}

export interface VoiceReplyWriter {
  /**
   * The reply's whole text as it stands. The first call puts the reply into the
   * chat as one message; every later call (more words, a cut, a provider's
   * correction) changes that same message in place.
   */
  set(text: string): void;
  /** Nothing more will change: write the last text now. */
  finish(): void;
}

export interface VoiceSessionLike {
  /** First wire event after WS upgrade. */
  onSessionStart(): void;
  /** Feed one mic PCM frame (16 kHz mono). */
  onMicFrame(pcm: Int16Array): Promise<void>;
  /** Surface emitted `chat.focus_change` — re-target the next utterance. */
  setFocus(chatId: string): void;
  /** spec/07 § Session modes — flip the open session's mode. */
  setMode(next: AudioSessionMode): void;
  getMode(): AudioSessionMode;
  getState(): SessionState;
  getCurrentChatId(): string;
  /** Voice-note gesture end (spec/07 ## Voice-input modes — mode 1). */
  finalizeNote(): Promise<boolean>;
  /** DEV/TEST seam: inject a transcribed utterance as if STT had produced it. */
  injectTranscript(text: string): Promise<void>;
  /** Synthesise + play `text` with no chat turn behind it. */
  speak(text: string): Promise<void>;
  close(): Promise<void>;
  stats(): {
    micFrames: number;
    micSeconds: number;
    vadEvents: number;
    turns: number;
    /** Loudest sample received, dBFS; -Infinity for a silent mic. */
    micPeakDbfs: number;
  };
  /** spec/07 § Call cost — what this session's engine used. */
  engineCosting(): EngineCosting;
  /**
   * spec/07 § The voice agent and the chat's agent — something from the chat
   * for the voice agent to speak about (a hand-off's answer, a reply that
   * ended a turn), held until nobody is talking. `handoffSettled`: it settles
   * one of this call's hand-offs. A session with no voice agent (the local
   * tier, dictation) has nobody to tell: there the chat agent's reply is
   * already what the session speaks or writes, so it ignores this.
   */
  pushMessage(text: string, opts?: { handoffSettled?: boolean }): void;
  /**
   * spec/07 § A dropped call comes back — the device's line went quiet
   * (`up: false`) and the session is held for it, or the device is back
   * (`up: true`). While it is down nothing is spoken: what the voice agent
   * has to say waits for the line, so no answer is said to nobody.
   */
  setLine(up: boolean): void;
}
