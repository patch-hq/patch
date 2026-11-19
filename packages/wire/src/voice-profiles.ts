// Voice profiles and the spoken-aloud prompt (spec/16 § Who is speaking,
// § Speaking aloud).
//
// A voice device sits in a room, so whoever is talking may not be the account's
// owner. A profile is a person Patch recognises by voice: a name, how much they
// may do, notes the agent should know about them, and a voiceprint, the mean
// speaker embedding of their recorded samples. The host computes embeddings
// (audio/speakerId.ts); matching is plain arithmetic, kept here so the host
// and Settings agree on it.

import { z } from 'zod';

/** What the voice is told about speaking through a speaker in a room. "Reset to default" writes this back. */
export const DEFAULT_VOICE_DEVICE_PROMPT = `You are speaking out loud through a speaker in a room. Anyone nearby can hear you, and the person talking may not be the account's owner.
Keep replies short and conversational: a sentence or two unless you are asked for more. Say things the way a person would, with no lists, markdown or links.
Never say anything private out loud (money, health, messages, passwords, addresses, or anything from the owner's accounts and files) unless you have been told the speaker is allowed to hear it.`;

/** Length of a voiceprint: the speaker model's embedding size. */
export const VOICEPRINT_DIM = 256;

/** The most people an account can enrol. */
export const VOICE_PROFILES_MAX = 20;

/**
 * - `owner`: everything: the chat's history and whatever the agent can do.
 * - `household`: may ask the agent for things. Not told the chat's history;
 *   the agent is told who is asking and reads their notes.
 * - `guest`: general conversation only. No agent, no history. Anyone Patch
 *   does not recognise is treated as a guest.
 */
export const VoiceProfileAccess = z.enum(['owner', 'household', 'guest']);
export type VoiceProfileAccess = z.infer<typeof VoiceProfileAccess>;

export const VoiceProfile = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(60),
    access: VoiceProfileAccess,
    /** What the voice and the agent should know when this person is speaking. */
    context: z.string().max(4000),
    /** Unit-length mean of the enrolled samples. Absent until one is recorded. */
    voiceprint: z.array(z.number()).length(VOICEPRINT_DIM).optional(),
    /** How many samples make up the voiceprint. */
    samples: z.number().int().nonnegative(),
  })
  .strict();
export type VoiceProfile = z.infer<typeof VoiceProfile>;

/**
 * How sure a match must be: the cosine similarity a voiceprint needs
 * (`voiceMatchThreshold`). Measured on synthetic voices, which share a vocoder
 * and so sit closer than real people: the same voice scores 0.92+ across
 * sentences, different voices up to 0.83. A wrong match hands a stranger
 * someone else's access, so the default leans strict; Settings offers the three.
 */
export const VOICE_MATCH_LEVELS = { relaxed: 0.65, normal: 0.75, strict: 0.85 } as const;
export const VOICE_MATCH_THRESHOLD = VOICE_MATCH_LEVELS.normal;
/** ...and must beat the next-best profile by this much, so two similar voices don't swap. */
export const VOICE_MATCH_MARGIN = 0.05;

/** Scale to unit length. A zero vector stays zero. */
export function normaliseVoiceprint(v: readonly number[]): number[] {
  let sq = 0;
  for (const x of v) sq += x * x;
  const n = Math.sqrt(sq);
  return n === 0 ? v.map(() => 0) : v.map((x) => x / n);
}

/** Cosine similarity of two voiceprints of the same length. */
export function voiceSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error('voiceprints differ in length');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Fold one more sample into a profile's voiceprint: the running mean, kept unit-length, rounded for storage. */
export function addVoiceSample(
  current: readonly number[] | undefined,
  samples: number,
  sample: readonly number[],
): number[] {
  const s = normaliseVoiceprint(sample);
  const merged =
    current === undefined || samples === 0
      ? s
      : current.map((x, i) => (x * samples + s[i]!) / (samples + 1));
  return normaliseVoiceprint(merged).map((x) => Math.round(x * 1e5) / 1e5);
}

export interface VoiceMatch {
  /** The recognised person, or null for nobody (treat as a guest). */
  profile: VoiceProfile | null;
  /** Best similarity found, for logs and Settings. */
  score: number;
}

/** Who is speaking, from an utterance's voiceprint. Profiles without a voiceprint never match. */
export function identifyVoice(
  voiceprint: readonly number[],
  profiles: readonly VoiceProfile[],
  threshold: number = VOICE_MATCH_THRESHOLD,
): VoiceMatch {
  let best: VoiceProfile | null = null;
  let bestScore = -1;
  let second = -1;
  for (const p of profiles) {
    if (!p.voiceprint) continue;
    const s = voiceSimilarity(voiceprint, p.voiceprint);
    if (s > bestScore) {
      second = bestScore;
      bestScore = s;
      best = p;
    } else if (s > second) {
      second = s;
    }
  }
  if (best === null) return { profile: null, score: 0 };
  const clear = bestScore >= threshold && bestScore - second >= VOICE_MATCH_MARGIN;
  return { profile: clear ? best : null, score: bestScore };
}

/** One utterance a voice device heard recently, offered in Settings for enrolment. */
export const RecentVoice = z
  .object({
    id: z.string().min(1),
    at: z.number().int(),
    /** What was said, so the user can tell who it was. */
    text: z.string(),
    seconds: z.number().nonnegative(),
    voiceprint: z.array(z.number()).length(VOICEPRINT_DIM),
    /** Who Patch took it to be at the time, if anyone. */
    matchedProfileId: z.string().optional(),
    score: z.number(),
  })
  .strict();
export type RecentVoice = z.infer<typeof RecentVoice>;
