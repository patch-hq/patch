// A voice device's session (spec/16 § Speaking aloud, § Who is speaking).
//
// A device sits in a room: the voice is told it is heard out loud, and, once
// the account has enrolled voice profiles, who is speaking and what that
// person may have. Enforcement is not left to the prompt: someone Patch does
// not recognise gets no chat history and no hand-off to the agent, decided
// here in code.

import type { RecentVoice, VoiceProfile } from '@patch/wire';
import type { RecentVoices } from './speakerId.js';

export interface DeviceVoiceDeps {
  /** What the voice is told about speaking aloud (`voiceDevicePrompt`). */
  prompt: () => string;
  /** The account's voice profiles. */
  profiles: () => readonly VoiceProfile[];
  /** Voiceprint of 16 kHz speech. Absent when this host cannot compute them. */
  embed?: (pcm: Int16Array) => Promise<number[]>;
  /** Where heard voices are kept for enrolment. */
  recent?: RecentVoices;
}

/** Whether a session should recognise speakers: some profile has a voiceprint to match. */
export function recognisesSpeakers(device: DeviceVoiceDeps | undefined): boolean {
  return device !== undefined && device.profiles().some((p) => p.voiceprint !== undefined);
}

/** Who the voice is talking to, for its instructions. `null` is someone not recognised. */
export function speakerInstruction(profile: VoiceProfile | null): string {
  if (profile === null || profile.access === 'guest') {
    const who = profile === null ? 'someone you do not recognise' : `${profile.name}, a guest`;
    return (
      `WHO IS SPEAKING: ${who}. Chat with them about anything general, but you cannot reach ` +
      "the agent, the chat's history or anything belonging to the account for them. If they " +
      'ask for something personal or an action, say kindly that you can only do that for ' +
      'someone you recognise.' +
      (profile !== null && profile.context ? ` About ${profile.name}: ${profile.context}` : '')
    );
  }
  const about = profile.context ? ` About ${profile.name}: ${profile.context}` : '';
  if (profile.access === 'household') {
    return (
      `WHO IS SPEAKING: ${profile.name}, a member of the household. Their requests can go to ` +
      "the agent. You have not been given the chat's history; do not offer the account " +
      "owner's private things." +
      about
    );
  }
  return `WHO IS SPEAKING: ${profile.name}, the account's owner.${about}`;
}

/** Whether this speaker may be told the chat's history and hand work to the agent. */
export function mayUseAgent(profile: VoiceProfile | null): boolean {
  return profile !== null && profile.access !== 'guest';
}

/** Whether this speaker may hear the chat's history. */
export function mayHearHistory(profile: VoiceProfile | null): boolean {
  return profile !== null && profile.access === 'owner';
}

/** What a hand-off's request is prefixed with, so the agent knows who asked. */
export function handoffSpeakerLine(profile: VoiceProfile): string {
  const role = profile.access === 'owner' ? "the account's owner" : 'a member of the household';
  return (
    `[Spoken by ${profile.name}, ${role}.${profile.context ? ` About ${profile.name}: ${profile.context}` : ''}]` +
    '\n'
  );
}

/** The answer a hand-off gets when the speaker may not use the agent. Decided here, never asked of the agent. */
export const HANDOFF_REFUSED =
  'Refused: this speaker is not recognised as someone who may use the agent. Tell them you can ' +
  'only do that for someone you recognise.';

/**
 * The last stretch of a session's microphone, so an utterance the provider's
 * VAD marked by milliseconds since the session's audio began can be cut out
 * for its voiceprint.
 */
export class MicTape {
  private readonly buf: Int16Array;
  /** Samples written since the start. */
  private written = 0;

  constructor(seconds = 30) {
    this.buf = new Int16Array(seconds * 16000);
  }

  push(pcm: Int16Array): void {
    for (let i = 0; i < pcm.length; i++) {
      this.buf[(this.written + i) % this.buf.length] = pcm[i]!;
    }
    this.written += pcm.length;
  }

  /** Samples between two offsets in ms; clipped to what is still on the tape. */
  slice(startMs: number, endMs: number): Int16Array {
    const from = Math.max(Math.floor(startMs * 16), this.written - this.buf.length, 0);
    const to = Math.min(Math.floor(endMs * 16), this.written);
    if (to <= from) return new Int16Array(0);
    const out = new Int16Array(to - from);
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(from + i) % this.buf.length]!;
    return out;
  }
}

export type { RecentVoice };
