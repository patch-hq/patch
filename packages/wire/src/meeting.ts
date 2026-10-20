// Meeting mode (a chat that listens to a meeting). The host owns a
// `MeetingState` per chat; surfaces render it and send audio + controls.
// Times are millisecond offsets from the start of the meeting, not wall-clock.

import { z } from 'zod';

export const MeetingStatus = z.enum(['live', 'paused', 'ended']);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

/** `you` is the microphone, `them` is system audio (everyone else on the call). */
export const MeetingSpeaker = z.enum(['you', 'them']);
export type MeetingSpeaker = z.infer<typeof MeetingSpeaker>;

export const MeetingTranscriptLine = z
  .object({
    at: z.number(),
    speaker: MeetingSpeaker,
    text: z.string(),
    /** Who was lit up on the call while this was said (desktop Accessibility); only on `them` lines. */
    name: z.string().min(1).optional(),
  })
  .strict();
export type MeetingTranscriptLine = z.infer<typeof MeetingTranscriptLine>;

export const MeetingNow = z
  .object({
    headline: z.string(),
    bullets: z.array(z.string()),
    /** Who has been speaking, e.g. "Dev, Priya". */
    who: z.string(),
  })
  .strict();
export type MeetingNow = z.infer<typeof MeetingNow>;

export const MeetingSummary = z
  .object({ headline: z.string(), bullets: z.array(z.string()) })
  .strict();
export type MeetingSummary = z.infer<typeof MeetingSummary>;

export const MeetingTopic = z
  .object({
    id: z.string().min(1),
    at: z.number(),
    title: z.string(),
    points: z.array(z.string()),
    decided: z.boolean(),
    /** Written or edited by the user: later analysis passes must leave it alone. */
    fixed: z.boolean().optional(),
  })
  .strict();
export type MeetingTopic = z.infer<typeof MeetingTopic>;

/**
 * A user edit to the points panel. A point is a topic: its `title` is the
 * "Speaker: main thrust" line and `points` are its bullets.
 */
export const MeetingNotesOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_title'), topicId: z.string().min(1), text: z.string() }).strict(),
  z
    .object({
      op: z.literal('set_bullet'),
      topicId: z.string().min(1),
      index: z.number().int().min(0),
      text: z.string(),
    })
    .strict(),
  /** Inserts an empty bullet so that it sits at `index`. */
  z
    .object({
      op: z.literal('add_bullet'),
      topicId: z.string().min(1),
      index: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      op: z.literal('remove_bullet'),
      topicId: z.string().min(1),
      index: z.number().int().min(0),
    })
    .strict(),
  /** A new empty point directly above (newer than) `aboveTopicId`; the surface picks `id` so it can focus it. */
  z
    .object({
      op: z.literal('insert'),
      aboveTopicId: z.string().min(1),
      id: z.string().min(1),
    })
    .strict(),
  /** Drops a point that is still completely empty. */
  z.object({ op: z.literal('remove'), topicId: z.string().min(1) }).strict(),
]);
export type MeetingNotesOp = z.infer<typeof MeetingNotesOp>;

/** Applies a user edit to the topics in place. Throws on an unknown point or bullet. */
export function applyMeetingNotesOp(topics: MeetingTopic[], op: MeetingNotesOp): void {
  const find = (id: string): MeetingTopic => {
    const t = topics.find((x) => x.id === id);
    if (!t) throw new Error(`no point ${id}`);
    return t;
  };
  const bullet = (t: MeetingTopic, i: number): void => {
    if (i >= t.points.length) throw new Error(`point ${t.id} has no bullet ${i}`);
  };
  switch (op.op) {
    case 'set_title': {
      const t = find(op.topicId);
      if (t.title !== op.text) {
        t.title = op.text;
        t.fixed = true;
      }
      return;
    }
    case 'set_bullet': {
      const t = find(op.topicId);
      bullet(t, op.index);
      if (t.points[op.index] !== op.text) {
        t.points[op.index] = op.text;
        t.fixed = true;
      }
      return;
    }
    case 'add_bullet': {
      const t = find(op.topicId);
      if (op.index > t.points.length) throw new Error(`point ${t.id} has no slot ${op.index}`);
      t.points.splice(op.index, 0, '');
      t.fixed = true;
      return;
    }
    case 'remove_bullet': {
      const t = find(op.topicId);
      bullet(t, op.index);
      t.points.splice(op.index, 1);
      t.fixed = true;
      return;
    }
    case 'insert': {
      if (topics.some((x) => x.id === op.id)) throw new Error(`point ${op.id} already exists`);
      const above = find(op.aboveTopicId);
      const newer = topics.filter((x) => x.at > above.at).map((x) => x.at);
      const next = newer.length ? Math.min(...newer) : above.at + 2;
      topics.push({
        id: op.id,
        at: Math.max(above.at + 1, Math.floor((above.at + next) / 2)),
        title: '',
        points: [],
        decided: false,
        fixed: true,
      });
      return;
    }
    case 'remove': {
      const t = find(op.topicId);
      if (t.title.trim() !== '' || t.points.some((p) => p.trim() !== ''))
        throw new Error(`point ${t.id} is not empty`);
      topics.splice(topics.indexOf(t), 1);
      return;
    }
  }
}

export const MeetingActionStatus = z.enum(['pending', 'running', 'done', 'dismissed']);
export type MeetingActionStatus = z.infer<typeof MeetingActionStatus>;

/** Who an action is for: Tom (`mine`), someone else (`other`, with an `owner`), or something an agent can do now (`agent`). */
export const MeetingActionKind = z.enum(['mine', 'other', 'agent']);
export type MeetingActionKind = z.infer<typeof MeetingActionKind>;

/** The owner choice that means no one person in particular. */
export const MEETING_OWNER_EVERYONE = 'Everyone';

export const MeetingAction = z
  .object({
    id: z.string().min(1),
    /** Absent on meetings saved before actions were classified: those were all Tom's. */
    kind: MeetingActionKind.default('mine'),
    /** For `other`: the speaker it falls to, or `Everyone`. */
    owner: z.string().min(1).optional(),
    /** The chat started for it: the agent's linked child chat, or the one Tom started. */
    chatId: z.string().min(1).optional(),
    title: z.string(),
    /** Why it was proposed — usually a quote and who said it. */
    why: z.string(),
    at: z.number(),
    status: MeetingActionStatus,
    /** Wall-clock ms when it was done or dismissed. */
    resolvedAt: z.number().optional(),
  })
  .strict();
export type MeetingAction = z.infer<typeof MeetingAction>;

/**
 * How live the notes are. `clipSeconds` is how much audio a surface gathers
 * before sending it to be transcribed; `analyseSeconds` is how often the model
 * folds new transcript into the notes. Shorter is fresher and costs more.
 */
export const MeetingSettings = z
  .object({
    clipSeconds: z.number().int().min(3).max(60),
    analyseSeconds: z.number().int().min(5).max(300),
  })
  .strict();
export type MeetingSettings = z.infer<typeof MeetingSettings>;

export const DEFAULT_MEETING_SETTINGS: MeetingSettings = { clipSeconds: 6, analyseSeconds: 15 };

export const MeetingState = z
  .object({
    status: MeetingStatus,
    startedAt: z.number(),
    endedAt: z.number().optional(),
    /** Running time banked before the current stretch (pauses excluded). */
    elapsedBaseMs: z.number(),
    /** Wall-clock ms the current live stretch began; absent while paused or ended. */
    resumedAt: z.number().optional(),
    now: MeetingNow.nullable(),
    /**
     * What has been said since the notes were last updated: provisional, and
     * replaced by `now` at the next analysis. Null when the notes are current.
     */
    live: z.string().nullable().optional(),
    settings: MeetingSettings.optional(),
    summary: MeetingSummary.nullable(),
    topics: z.array(MeetingTopic),
    /** Free text the user types during or after the call; the final write-up folds it in. */
    myNotes: z.string().optional(),
    actions: z.array(MeetingAction),
    /** When on, agent actions start by themselves in a linked chat. */
    agentRunsActions: z.boolean().optional(),
    transcript: z.array(MeetingTranscriptLine),
    /** Set when the last analysis or transcription failed; cleared by the next success. */
    error: z.string().nullable(),
  })
  .strict();
export type MeetingState = z.infer<typeof MeetingState>;

/** How a transcript line's speaker is shown: You, the named participant, or Them. */
export function meetingSpeakerLabel(l: { speaker: MeetingSpeaker; name?: string }): string {
  return l.speaker === 'you' ? 'You' : (l.name ?? 'Them');
}

/** Total running time of a meeting at wall-clock `nowMs`. */
export function meetingElapsedMs(m: MeetingState, nowMs: number): number {
  return m.elapsedBaseMs + (m.resumedAt !== undefined ? Math.max(0, nowMs - m.resumedAt) : 0);
}

/** mm:ss, or h:mm:ss from an hour. */
export function formatMeetingClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
