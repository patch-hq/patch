// Meeting mode (host side). A chat can listen to a meeting: surfaces upload
// short audio clips, the host transcribes them with the LOCAL Whisper (never a
// paid STT), and about every 30s one cheap model pass folds the new transcript
// into Now / Discussed / Actions. The raw transcript is never posted as chat
// messages; it reaches the chat's model as a system-reminder on the user's next
// turn (see `contextFor`).
//
// The analysis loop is a host timer, not a page timer, so it keeps going while
// a window is hidden. NO FALLBACK: a failed transcription or analysis is
// logged and put on `state.error` for the panel to show; it is never swallowed.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { nameFixes } from './meetingVocab.js';
import type { Logger } from 'pino';
import {
  meetingElapsedMs,
  meetingSpeakerLabel,
  formatMeetingClock,
  DEFAULT_MEETING_SETTINGS,
  MeetingSettings,
  applyMeetingNotesOp,
  type MeetingNotesOp,
  type MeetingAction,
  type MeetingAgentNotesEdit,
  MeetingActionKind,
  MeetingCardKind,
  MeetingCardSource,
  MeetingVerdict,
  meetingCardProblem,
  DEFAULT_MEETING_RESEARCH_SECONDS,
  type MeetingNow,
  MeetingState,
  MeetingWriteup,
  type MeetingSummary,
  type MeetingTopic,
  type WireEvent,
} from '@patch/wire';

export const MEETING_ANALYSE_INTERVAL_MS = DEFAULT_MEETING_SETTINGS.analyseSeconds * 1000;
/** Longest provisional "Now" text kept on the state. */
const MAX_LIVE_CHARS = 300;
/** Transcript kept on the state; the oldest lines roll off past this. */
const MAX_TRANSCRIPT_LINES = 4000;
/** Most name corrections kept for the write-up's tooltips. */
const NAME_FIX_LIMIT = 200;
/** Cap on transcript fed into one analysis pass or one chat turn. */
const MAX_PROMPT_TRANSCRIPT_CHARS = 12_000;

export const MeetingAnalysis = z
  .object({
    now: z.object({ headline: z.string(), bullets: z.array(z.string()), who: z.string() }),
    topics: z.array(
      z.object({
        id: z.string().nullable().optional(),
        title: z.string(),
        points: z.array(z.string()),
        decided: z.boolean().optional(),
        atSeconds: z.number().optional(),
      }),
    ),
    actions: z.array(
      z
        .object({
          kind: MeetingActionKind,
          owner: z.string().min(1).optional(),
          title: z.string(),
          why: z.string(),
          atSeconds: z.number().optional(),
        })
        .refine((a) => a.kind !== 'other' || a.owner !== undefined, {
          message: 'an action for someone else needs an owner',
        }),
    ),
    /** Names for `Them N` voices, where the transcript makes who they are clear. */
    voices: z.array(z.object({ voice: z.number().int().min(1), name: z.string() })).optional(),
    summary: z
      .object({ headline: z.string(), bullets: z.array(z.string()) })
      .nullable()
      .optional(),
  })
  .strict();
export type MeetingAnalysis = z.infer<typeof MeetingAnalysis>;

/** What the research pass returns; each card is checked by `meetingCardProblem` before it is shown. */
export const MeetingResearchResult = z
  .object({
    cards: z.array(
      z
        .object({
          kind: MeetingCardKind,
          title: z.string().min(1),
          atSeconds: z.number().optional(),
          bullets: z.array(z.string().min(1)),
          verdict: MeetingVerdict.optional(),
          source: MeetingCardSource.optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type MeetingResearchResult = z.infer<typeof MeetingResearchResult>;

export interface ResearchInput {
  chatId: string;
  lines: { clock: string; speaker: string; text: string }[];
  /** Titles of cards already in the feed, so they are not researched again. */
  existing: string[];
  context: { now: string | null };
}

export interface MeetingPrompts {
  now: string;
  notes: string;
  actions: string;
}

export interface AnalyseInput {
  chatId: string;
  /** What the panel already shows, so the model updates rather than restarts. */
  previous: { now: MeetingNow | null; topics: MeetingTopic[]; actions: MeetingAction[] };
  newLines: { clock: string; speaker: string; text: string }[];
  /** The meeting has ended: also return `summary`. */
  final: boolean;
  elapsedMs: number;
  /** Tom's own notes so far: they often name who is on the call. */
  myNotes: string;
  /** The account's three editable instruction blocks, read fresh each pass. */
  prompts: MeetingPrompts;
}

export interface WriteupInput {
  chatId: string;
  /** Meeting date, e.g. "20 Oct". */
  date: string;
  durationMinutes: number;
  /** The whole cleaned transcript. */
  lines: { clock: string; speaker: string; text: string }[];
  /** Tom's own notes, verbatim; the write-up keeps his words and marks them `mine`. */
  myNotes: string;
  /** The points the live pass built, for emphasis only; the transcript is the source. */
  points: string[];
  prompts: MeetingPrompts;
}

export interface CorrectInput {
  chatId: string;
  /** Terms the user wants spelt a particular way; each entry may list mishearings after a colon. */
  glossary: string[];
  /** What the notes already say, so names can be judged against the meeting's subject. */
  context: { now: string | null; topics: string[] };
  /** Lines already cleaned, immediately before `lines`, for continuity only. */
  before: string[];
  lines: { speaker: string; text: string }[];
}

export interface MeetingDeps {
  dir: string;
  /** Local Whisper only. */
  transcribe: (wav: Buffer) => Promise<string>;
  /**
   * Local diarisation: transcribes a `them` clip and says which distinct voice
   * spoke each stretch. `session` is stable for the whole meeting so voice
   * numbers stay the same across clips. Omitted: `them` stays one speaker.
   */
  transcribeVoices?: (session: string, wav: Buffer) => Promise<{ text: string; voice: number }[]>;
  /**
   * True once the owner has a voice print. Then every clip (mic included) is
   * diarised and voice 0 is the owner: those lines are 'you' whichever channel
   * they came in on, so in-room speech with no app still reads as the owner.
   */
  hasVoiceprint?: () => boolean;
  analyse: (input: AnalyseInput) => Promise<MeetingAnalysis>;
  /**
   * Cheap pass over new transcript lines that repairs mis-heard names and places
   * before the notes are built. Returns one corrected text per input line.
   * Omitted: transcripts go to analysis as transcribed.
   */
  correct?: (input: CorrectInput) => Promise<string[]>;
  /**
   * The final write-up, written when the meeting ends and on Regenerate.
   * Omitted: no write-up is made and the Summary tab says so.
   */
  writeup?: (input: WriteupInput) => Promise<MeetingWriteup>;
  /** Live research: one model plus web search over new transcript. Omitted: no research. */
  research?: (input: ResearchInput) => Promise<MeetingResearchResult>;
  /** Least seconds between research passes, read fresh so a Settings change applies mid-meeting. */
  researchSeconds?: () => number;
  /** The glossary, read fresh each pass so edits apply mid-meeting. */
  glossary?: () => string[];
  /** The meeting prompts, read fresh each pass so edits apply mid-meeting. */
  prompts: () => MeetingPrompts;
  emit: (event: WireEvent) => void;
  /**
   * Start a new chat linked to the meeting's chat, seeded with `message`, and
   * return its id. It runs through the chat's normal tools and permissions.
   */
  startChat: (parentChatId: string, message: string) => Promise<string>;
  /** Names the meeting's chat after its write-up. Omitted: the chat keeps its name. */
  nameChat?: (chatId: string, title: string) => Promise<void>;
  logger: Logger;
  now?: () => number;
  newId?: () => string;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

interface Runtime {
  state: MeetingState;
  timer: unknown;
  /** Index into `state.transcript` already analysed. */
  analysedUpTo: number;
  /** Index into `state.transcript` already given to the chat's model. */
  deliveredUpTo: number;
  /** Index into `state.transcript` already through the correction pass. */
  correctedUpTo: number;
  /** Index into `state.transcript` already given to research. */
  researchedUpTo: number;
  /** Wall-clock ms the last research pass started; not persisted (a restart may research at once). */
  lastResearchAt: number;
  /** The pass in flight, so only one runs and tests can wait for it. */
  researching: Promise<void> | undefined;
  /** Serialises analysis and write-ups. */
  chain: Promise<void>;
  /** Serialises transcription alone, so a slow analysis pass never holds clips back. */
  txChain: Promise<void>;
}

/** Consecutive segments from one voice read as one line. */
function mergeVoiceRuns(
  segs: { text: string; voice: number }[],
): { text: string; voice: number }[] {
  const out: { text: string; voice: number }[] = [];
  for (const g of segs) {
    const text = g.text.trim();
    if (text === '') continue;
    const last = out[out.length - 1];
    if (last && last.voice === g.voice) last.text += ` ${text}`;
    else out.push({ text, voice: g.voice });
  }
  return out;
}

/** How far apart (ms of meeting time) a mic line and a system line can be and still be one utterance. */
const ECHO_WINDOW_MS = 30_000;
/** Shorter lines are too easily genuine ("yes", "right, thanks"), so they are never treated as echo. */
const ECHO_MIN_WORDS = 4;
const ECHO_MIN_OVERLAP = 0.6;

const echoWords = (t: string): string[] =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');

/** Within one edit: Whisper garbles a word rather than replacing it. */
function nearWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

/**
 * True when a system-audio line is the owner's own mic speech coming back through the
 * speakers: most of its words appear in the mic text from the same few seconds.
 */
export function isMicEcho(systemText: string, micTexts: string[]): boolean {
  const words = echoWords(systemText);
  if (words.length < ECHO_MIN_WORDS) return false;
  const pool = micTexts.flatMap(echoWords);
  if (pool.length === 0) return false;
  const hit = words.filter((w) => pool.some((p) => nearWord(w, p))).length;
  return hit / words.length >= ECHO_MIN_OVERLAP;
}

/** The model complaining about its input instead of writing notes. */
const META_TEXT = /\bno (new )?transcript\b|nothing (new )?to (process|summari[sz]e)/i;

export class MeetingError extends Error {
  override readonly name = 'MeetingError';
}

export class MeetingManager {
  private readonly runtimes = new Map<string, Runtime>();
  /** Actions whose dispatch is in flight, so a second decision cannot run one twice. */
  private readonly deciding = new Set<string>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: MeetingDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => Math.random().toString(36).slice(2, 10));
    mkdirSync(deps.dir, { recursive: true });
  }

  // ---- reads ----

  get(chatId: string): MeetingState | null {
    return this.load(chatId)?.state ?? null;
  }

  publish(chatId: string): void {
    this.deps.emit({ type: 'meeting.state', chatId, meeting: this.get(chatId) });
  }

  // ---- controls ----

  start(chatId: string, settings?: MeetingSettings): void {
    const existing = this.load(chatId);
    if (existing && existing.state.status !== 'ended') {
      throw new MeetingError(`chat ${chatId} already has a ${existing.state.status} meeting`);
    }
    const t = this.now();
    const rt: Runtime = {
      state: {
        status: 'live',
        startedAt: t,
        elapsedBaseMs: 0,
        resumedAt: t,
        now: null,
        live: null,
        settings: settings ? MeetingSettings.parse(settings) : { ...DEFAULT_MEETING_SETTINGS },
        summary: null,
        topics: [],
        actions: [],
        cards: [],
        researchOn: true,
        agentEdits: [],
        transcript: [],
        error: null,
      },
      timer: undefined,
      analysedUpTo: 0,
      deliveredUpTo: 0,
      correctedUpTo: 0,
      researchedUpTo: 0,
      lastResearchAt: 0,
      researching: undefined,
      chain: Promise.resolve(),
      txChain: Promise.resolve(),
    };
    this.runtimes.set(chatId, rt);
    this.armTimer(chatId, rt);
    this.commit(chatId, rt);
  }

  /** Change how often the notes update; takes effect on the running timer now. */
  tune(chatId: string, settings: MeetingSettings): void {
    const rt = this.load(chatId);
    if (!rt || rt.state.status === 'ended') {
      throw new MeetingError(`chat ${chatId} has no running meeting to tune`);
    }
    rt.state.settings = MeetingSettings.parse(settings);
    if (rt.state.status === 'live') this.armTimer(chatId, rt);
    this.commit(chatId, rt);
  }

  pause(chatId: string): void {
    const rt = this.requireStatus(chatId, 'live');
    rt.state.elapsedBaseMs = meetingElapsedMs(rt.state, this.now());
    delete rt.state.resumedAt;
    rt.state.status = 'paused';
    this.disarmTimer(rt);
    this.commit(chatId, rt);
  }

  /** Resumes a paused meeting, or reopens one that has ended (its write-up stays until it ends again). */
  resume(chatId: string): void {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting`);
    if (rt.state.status === 'live') {
      throw new MeetingError(`chat ${chatId}'s meeting is live, not paused or ended`);
    }
    delete rt.state.endedAt;
    rt.state.status = 'live';
    rt.state.resumedAt = this.now();
    this.armTimer(chatId, rt);
    this.commit(chatId, rt);
  }

  /** Ends the meeting and runs the final pass (which writes the summary). */
  async end(chatId: string): Promise<void> {
    const rt = this.load(chatId);
    if (!rt || rt.state.status === 'ended') {
      throw new MeetingError(`chat ${chatId} has no meeting to end`);
    }
    const t = this.now();
    rt.state.elapsedBaseMs = meetingElapsedMs(rt.state, t);
    delete rt.state.resumedAt;
    rt.state.status = 'ended';
    rt.state.endedAt = t;
    this.disarmTimer(rt);
    this.commit(chatId, rt);
    await rt.txChain;
    await this.enqueue(rt, async () => {
      await this.analyse(chatId, rt, true);
      await this.writeUp(chatId, rt);
    });
  }

  /** Removes an ended meeting and its stored transcript from the chat; waits for any final pass still writing it. */
  async delete(chatId: string): Promise<void> {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting to delete`);
    if (rt.state.status !== 'ended') {
      throw new MeetingError(
        `chat ${chatId}'s meeting is ${rt.state.status}: end it before deleting`,
      );
    }
    await rt.txChain;
    await rt.chain;
    this.runtimes.delete(chatId);
    rmSync(this.file(chatId), { force: true });
    this.deps.emit({ type: 'meeting.state', chatId, meeting: null });
  }

  /** Writes the final write-up again from the transcript and My notes as they are now. */
  async regenerateWriteup(chatId: string): Promise<void> {
    const rt = this.requireStatus(chatId, 'ended');
    await this.enqueue(rt, () => this.writeUp(chatId, rt));
  }

  /** Stores the user's edited write-up. Their wording is theirs: it is marked `mine`. */
  setWriteup(chatId: string, writeup: MeetingWriteup): void {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting`);
    rt.state.writeup = MeetingWriteup.parse(writeup);
    this.commit(chatId, rt);
  }

  private async writeUp(chatId: string, rt: Runtime): Promise<void> {
    if (!this.deps.writeup) {
      rt.state.writeupError = 'no write-up generator is configured on this host';
      this.commit(chatId, rt);
      return;
    }
    const s = rt.state;
    try {
      const w = await this.deps.writeup({
        chatId,
        date: new Date(s.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
        durationMinutes: Math.max(1, Math.round(s.elapsedBaseMs / 60_000)),
        lines: s.transcript.map((l) => ({
          clock: formatMeetingClock(l.at),
          speaker: meetingSpeakerLabel(l, s.voices),
          text: l.text,
        })),
        myNotes: s.myNotes ?? '',
        points: s.topics.map((t) => t.title),
        prompts: this.deps.prompts(),
      });
      const parsed = MeetingWriteup.parse(w);
      if (
        META_TEXT.test(
          `${parsed.title} ${parsed.sections.flatMap((x) => x.items.map((i) => i.text)).join(' ')}`,
        )
      )
        throw new MeetingError(`write-up returned model commentary: ${parsed.title}`);
      s.writeup = parsed;
      s.writeupError = null;
      // The write-up's title names the chat: it is where a title is read.
      if (this.deps.nameChat && parsed.title.trim() !== '')
        await this.deps.nameChat(chatId, parsed.title.trim());
    } catch (err) {
      s.writeupError = `write-up failed: ${(err as Error).message}`;
      this.deps.logger.error({ chatId, err: (err as Error).message }, 'meeting: write-up failed');
    }
    this.commit(chatId, rt);
  }

  // ---- audio ----

  /** Resolves once the clip is transcribed and on the state. */
  ingestAudio(
    chatId: string,
    source: 'mic' | 'system',
    wav: Buffer,
    speakerName?: string,
  ): Promise<void> {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting`);
    // A surface flushes its last clip before sending End; later audio is a bug.
    if (rt.state.status === 'ended') {
      throw new MeetingError(`chat ${chatId}'s meeting has ended`);
    }
    const at = meetingElapsedMs(rt.state, this.now());
    const next = rt.txChain.then(async () => {
      const speaker = source === 'mic' ? 'you' : 'them';
      const printed = !!this.deps.transcribeVoices && !!this.deps.hasVoiceprint?.();
      let pieces: { text: string; voice?: number }[];
      try {
        if (this.deps.transcribeVoices && (speaker === 'them' || printed)) {
          pieces = mergeVoiceRuns(
            await this.deps.transcribeVoices(`${chatId}:${rt.state.startedAt}`, wav),
          );
        } else {
          pieces = [{ text: (await this.deps.transcribe(wav)).trim() }];
        }
      } catch (err) {
        rt.state.error = `transcription failed: ${(err as Error).message}`;
        this.deps.logger.error(
          { chatId, err: (err as Error).message },
          'meeting: transcription failed',
        );
        this.commit(chatId, rt);
        return;
      }
      let added = false;
      const recentMic = () =>
        rt.state.transcript
          .filter((l) => l.speaker === 'you' && Math.abs(at - l.at) <= ECHO_WINDOW_MS)
          .map((l) => l.text);
      for (const { text, voice } of pieces) {
        if (text === '') continue;
        // Voice 0 is the owner's print; any other voice is someone else, even on the mic.
        const lineSpeaker =
          printed && voice !== undefined ? (voice === 0 ? 'you' : 'them') : speaker;
        // The owner's voice returning through system audio is not a second speaker.
        if (lineSpeaker === 'them' && source === 'system' && isMicEcho(text, recentMic())) continue;
        if (lineSpeaker === 'you' && source === 'mic') {
          // The system clip can land first: retract its echo now the mic text is known.
          // Only lines no pass has consumed yet, so the progress markers stay valid.
          const floor = Math.max(
            rt.analysedUpTo,
            rt.deliveredUpTo,
            rt.correctedUpTo,
            rt.researchedUpTo,
          );
          const before = rt.state.transcript.length;
          rt.state.transcript = rt.state.transcript.filter(
            (l, i) =>
              !(
                l.speaker === 'them' &&
                i >= floor &&
                Math.abs(at - l.at) <= ECHO_WINDOW_MS &&
                isMicEcho(l.text, [text])
              ),
          );
          if (rt.state.transcript.length !== before) added = true;
        }
        rt.state.transcript.push({
          at,
          speaker: lineSpeaker,
          ...(voice !== undefined && voice !== 0 ? { voice } : {}),
          ...(lineSpeaker === 'them' && speakerName ? { name: speakerName } : {}),
          text,
        });
        added = true;
      }
      if (!added) return;
      if (rt.state.transcript.length > MAX_TRANSCRIPT_LINES) {
        const drop = rt.state.transcript.length - MAX_TRANSCRIPT_LINES;
        rt.state.transcript.splice(0, drop);
        rt.analysedUpTo = Math.max(0, rt.analysedUpTo - drop);
        rt.deliveredUpTo = Math.max(0, rt.deliveredUpTo - drop);
        rt.correctedUpTo = Math.max(0, rt.correctedUpTo - drop);
        rt.researchedUpTo = Math.max(0, rt.researchedUpTo - drop);
      }
      rt.state.error = null;
      this.commit(chatId, rt);
    });
    rt.txChain = next.catch(() => undefined);
    return next;
  }

  /** Show `name` for a `them` voice (e.g. the user recognised Them 2 as Priya). */
  nameVoice(chatId: string, voice: number, name: string): void {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting`);
    if (!rt.state.transcript.some((l) => l.voice === voice)) {
      throw new MeetingError(`chat ${chatId}'s meeting has no voice ${voice}`);
    }
    rt.state.voices = { ...rt.state.voices, [String(voice)]: name };
    this.commit(chatId, rt);
  }

  // ---- points ----

  /** A user edit to a point or bullet, or a new point. Marks the point fixed so analysis leaves it. */
  editNotes(chatId: string, edit: MeetingNotesOp): void {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting`);
    try {
      applyMeetingNotesOp(rt.state.topics, edit);
    } catch (err) {
      throw new MeetingError(`cannot edit points in chat ${chatId}: ${(err as Error).message}`);
    }
    this.commit(chatId, rt);
  }

  /** Stores the user's My notes text with the meeting; it is theirs, so analysis never touches it. */
  setMyNotes(chatId: string, text: string): void {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting`);
    if ((rt.state.myNotes ?? '') === text) return;
    rt.state.myNotes = text;
    this.commit(chatId, rt);
  }

  // ---- research ----

  /** The "Research as we go" checkbox. Turning it on starts from now, not from the start of the call. */
  setResearch(chatId: string, on: boolean): void {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting`);
    if ((rt.state.researchOn ?? false) === on) return;
    rt.state.researchOn = on;
    if (on) rt.researchedUpTo = rt.state.transcript.length;
    this.commit(chatId, rt);
  }

  /** Resolves when the research pass in flight, if any, has landed. Exposed for tests. */
  async settleResearch(chatId: string): Promise<void> {
    await this.load(chatId)?.researching;
  }

  /**
   * After an analysis pass: research the lines nobody has researched yet, at most
   * once per `researchSeconds`, and never two at once. Throttled lines wait for
   * the next pass rather than being dropped.
   */
  private maybeResearch(chatId: string, rt: Runtime): void {
    const research = this.deps.research;
    if (!research || rt.state.researchOn !== true || rt.state.status !== 'live') return;
    if (rt.researching) return;
    const fresh = rt.state.transcript.slice(rt.researchedUpTo);
    if (fresh.length === 0) return;
    const t = this.now();
    const gapMs = (this.deps.researchSeconds?.() ?? DEFAULT_MEETING_RESEARCH_SECONDS) * 1000;
    if (rt.lastResearchAt !== 0 && t - rt.lastResearchAt < gapMs) return;
    rt.lastResearchAt = t;
    const upTo = rt.state.transcript.length;
    const cards = rt.state.cards ?? [];
    const run = research({
      chatId,
      lines: fresh.map((l) => ({
        clock: formatMeetingClock(l.at),
        speaker: meetingSpeakerLabel(l),
        text: l.text,
      })),
      existing: cards.map((c) => c.title),
      context: { now: rt.state.now?.headline ?? null },
    })
      .then((res) => {
        const rejected = this.addCards(chatId, rt, res);
        rt.researchedUpTo = Math.max(rt.researchedUpTo, upTo);
        rt.state.researchError = rejected.length
          ? `research card not shown: ${rejected.join('; ')}`
          : null;
      })
      .catch((err: unknown) => {
        rt.state.researchError = `research failed: ${(err as Error).message}`;
        this.deps.logger.error({ chatId, err: (err as Error).message }, 'meeting: research failed');
      })
      .then(() => {
        rt.researching = undefined;
        this.commit(chatId, rt);
      });
    rt.researching = run;
  }

  /** Dedupes by term and keeps the cards that follow the sourcing rules; returns why each other was refused. */
  private addCards(chatId: string, rt: Runtime, res: MeetingResearchResult): string[] {
    const s = rt.state;
    const cards = (s.cards ??= []);
    const key = (x: string): string =>
      x
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const rejected: string[] = [];
    for (const c of res.cards) {
      const k = key(c.title);
      if (k === '' || cards.some((x) => x.key === k)) continue;
      const problem = meetingCardProblem(c);
      if (problem) {
        rejected.push(`"${c.title}": ${problem}`);
        continue;
      }
      cards.push({
        id: this.newId(),
        kind: c.kind,
        key: k,
        title: c.title,
        at: c.atSeconds !== undefined ? c.atSeconds * 1000 : meetingElapsedMs(s, this.now()),
        bullets: c.bullets,
        ...(c.verdict !== undefined ? { verdict: c.verdict } : {}),
        ...(c.source !== undefined ? { source: c.source } : {}),
      });
    }
    if (rejected.length)
      this.deps.logger.error({ chatId, rejected }, 'meeting: research cards rejected');
    return rejected;
  }

  // ---- agent edits ----

  /**
   * The chat agent changing the notes. The point it touches becomes fixed, so a
   * later analysis pass leaves it alone. Returns the chip label for its reply.
   */
  agentEdit(chatId: string, edit: MeetingAgentNotesEdit): string {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting`);
    const s = rt.state;
    const find = (id: string): MeetingTopic => {
      const t = s.topics.find((x) => x.id === id);
      if (!t) throw new MeetingError(`no point ${id} in chat ${chatId}`);
      return t;
    };
    let label: string;
    switch (edit.op) {
      case 'add_point':
        s.topics.push({
          id: this.newId(),
          at: meetingElapsedMs(s, this.now()),
          title: edit.title,
          points: edit.bullets ?? [],
          decided: edit.decided ?? false,
          fixed: true,
        });
        label = 'Added to points';
        break;
      case 'edit_point': {
        const t = find(edit.topicId);
        if (edit.title === undefined && edit.bullets === undefined)
          throw new MeetingError('edit_point needs a title or bullets');
        if (edit.title !== undefined) t.title = edit.title;
        if (edit.bullets !== undefined) t.points = edit.bullets;
        t.fixed = true;
        label = 'Edited a point';
        break;
      }
      case 'add_research': {
        const t = find(edit.topicId);
        const problem = meetingCardProblem({
          kind: 'explained',
          title: t.title,
          bullets: edit.bullets,
          source: edit.source,
        });
        if (problem) throw new MeetingError(`research not added: ${problem}`);
        const tail = edit.source ? ` (${edit.source.name}: ${edit.source.url})` : '';
        const added = edit.bullets.map((b, i) => (i === edit.bullets.length - 1 ? b + tail : b));
        t.points = [...t.points, ...added];
        t.fixed = true;
        label = 'Added research to points';
        break;
      }
      case 'set_summary':
        s.summary = { headline: edit.headline, bullets: edit.bullets };
        label = 'Edited the summary';
        break;
    }
    (s.agentEdits ??= []).push({ id: this.newId(), at: this.now(), label });
    this.commit(chatId, rt);
    return label;
  }

  // ---- actions ----

  /**
   * `do` runs an agent action in a linked chat and `chat` starts one on an
   * action of Tom's; both leave the row pointing at that chat. Someone else's
   * action never starts a chat. `dismiss` drops any row.
   */
  async decide(
    chatId: string,
    actionId: string,
    decision: 'do' | 'chat' | 'dismiss' | 'done' | 'reopen',
  ): Promise<void> {
    const rt = this.load(chatId);
    const action = rt?.state.actions.find((a) => a.id === actionId);
    if (!rt || !action) throw new MeetingError(`no action ${actionId} in chat ${chatId}`);
    if (decision === 'reopen') {
      if (action.status !== 'done') throw new MeetingError(`action ${actionId} is not done`);
      action.status = action.chatId ? 'running' : 'pending';
      delete action.resolvedAt;
      this.commit(chatId, rt);
      return;
    }
    if (action.status === 'dismissed' || action.status === 'done') {
      throw new MeetingError(`action ${actionId} is already ${action.status}`);
    }
    if (decision === 'done') {
      action.status = 'done';
      action.resolvedAt = this.now();
      this.commit(chatId, rt);
      return;
    }
    if (decision === 'dismiss') {
      action.status = 'dismissed';
      action.resolvedAt = this.now();
      this.commit(chatId, rt);
      return;
    }
    const wanted = decision === 'do' ? 'agent' : 'mine';
    if (action.kind !== wanted) {
      throw new MeetingError(
        `action ${actionId} is ${action.kind}'s, so it cannot be "${decision}"`,
      );
    }
    await this.startActionChat(chatId, rt, action);
  }

  /** Reassigns someone else's action to a speaker or `Everyone`. */
  setActionOwner(chatId: string, actionId: string, owner: string): void {
    const rt = this.load(chatId);
    const action = rt?.state.actions.find((a) => a.id === actionId);
    if (!rt || !action) throw new MeetingError(`no action ${actionId} in chat ${chatId}`);
    if (action.kind !== 'other') throw new MeetingError(`action ${actionId} has no owner to set`);
    if (action.owner === owner) return;
    action.owner = owner;
    this.commit(chatId, rt);
  }

  /** Hands an action to Tom (`mine`), the agent (`agent`) or someone else (`other`, with `owner`). */
  assignAction(
    chatId: string,
    actionId: string,
    to: { kind: MeetingAction['kind']; owner?: string | undefined },
  ): void {
    const rt = this.load(chatId);
    const action = rt?.state.actions.find((a) => a.id === actionId);
    if (!rt || !action) throw new MeetingError(`no action ${actionId} in chat ${chatId}`);
    if ((to.kind === 'other') !== (to.owner !== undefined))
      throw new MeetingError('an action for someone else needs an owner, and only then');
    action.kind = to.kind;
    if (to.owner !== undefined) action.owner = to.owner;
    else delete action.owner;
    this.commit(chatId, rt);
  }

  /** Rewrites an action's text. */
  setActionTitle(chatId: string, actionId: string, title: string): void {
    const rt = this.load(chatId);
    const action = rt?.state.actions.find((a) => a.id === actionId);
    if (!rt || !action) throw new MeetingError(`no action ${actionId} in chat ${chatId}`);
    action.title = title;
    this.commit(chatId, rt);
  }

  /** An action Tom wrote himself, at the meeting's time now. */
  addAction(
    chatId: string,
    add: { title: string; kind: MeetingAction['kind']; owner?: string | undefined },
  ): void {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting`);
    if ((add.kind === 'other') !== (add.owner !== undefined))
      throw new MeetingError('an action for someone else needs an owner, and only then');
    rt.state.actions.push({
      id: this.newId(),
      kind: add.kind,
      ...(add.owner !== undefined ? { owner: add.owner } : {}),
      title: add.title,
      why: '',
      at: meetingElapsedMs(rt.state, this.now()),
      status: 'pending',
    });
    this.commit(chatId, rt);
  }

  /**
   * The retired "agent does its own actions" switch. Agent actions always wait
   * for Approve now, so only turning it off is accepted (older surfaces still send it).
   */
  setAgentRunsActions(chatId: string, on: boolean): void {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting`);
    if (on)
      throw new MeetingError('agent actions wait for Approve; they no longer run by themselves');
    delete rt.state.agentRunsActions;
    this.commit(chatId, rt);
  }

  private async startActionChat(chatId: string, rt: Runtime, action: MeetingAction): Promise<void> {
    const key = `${chatId}:${action.id}`;
    if (this.deciding.has(key)) {
      throw new MeetingError(`action ${action.id} is already being started`);
    }
    if (action.status !== 'pending') {
      throw new MeetingError(`action ${action.id} is already ${action.status}`);
    }
    this.deciding.add(key);
    try {
      // Start first: if the chat cannot be made the row must stay pending.
      action.chatId = await this.deps.startChat(chatId, this.seedFor(rt.state, action));
    } finally {
      this.deciding.delete(key);
    }
    action.status = 'running';
    action.resolvedAt = this.now();
    this.commit(chatId, rt);
  }

  /** The first message of an action's chat: the action and enough of the meeting to act on it. */
  private seedFor(s: MeetingState, a: MeetingAction): string {
    const lines = [
      a.kind === 'agent'
        ? `Do this action from a meeting: ${a.title}`
        : `Help me with this action from a meeting: ${a.title}`,
      `Why it came up: ${a.why}`,
      '',
      'Meeting context:',
    ];
    const headline = s.summary?.headline ?? s.now?.headline;
    if (headline) lines.push(`Gist: ${headline}`);
    for (const t of s.topics)
      lines.push(`- ${formatMeetingClock(t.at)} ${t.title}: ${t.points.join('; ')}`);
    if (s.myNotes?.trim()) lines.push('My notes:', s.myNotes.trim());
    return lines.join('\n');
  }

  // ---- chat context ----

  /**
   * A `<system-reminder>` for the chat's next turn: the panel as it stands plus
   * transcript the model has not been given yet. Undefined when there is no
   * meeting or nothing new. Calling it marks the transcript as delivered.
   */
  contextFor(chatId: string): string | undefined {
    const rt = this.load(chatId);
    if (!rt) return undefined;
    const fresh = rt.state.transcript.slice(rt.deliveredUpTo);
    if (fresh.length === 0 && rt.state.status === 'ended') return undefined;
    rt.deliveredUpTo = rt.state.transcript.length;
    const s = rt.state;
    const lines: string[] = [
      '<system-reminder>',
      `A meeting is ${s.status} in this chat (running ${formatMeetingClock(meetingElapsedMs(s, this.now()))}). Answer questions about it from what follows; look things up and use your tools when asked. Do not take actions on other people\'s behalf unless the user asks. When the user asks you to add to or change the notes (a point, research on a point, the summary), do it with the patch_meeting_notes tool and say what you changed; never state a figure without a source.`,
    ];
    if (s.summary)
      lines.push(`Summary: ${s.summary.headline}`, ...s.summary.bullets.map((b) => `- ${b}`));
    else if (s.now)
      lines.push(`Right now: ${s.now.headline}`, ...s.now.bullets.map((b) => `- ${b}`));
    if (s.topics.length)
      lines.push(
        'Discussed:',
        ...s.topics.map(
          (t) =>
            `- [${t.id}] ${formatMeetingClock(t.at)} ${t.title}${t.decided ? ' (decided)' : ''}: ${t.points.join('; ')}`,
        ),
      );
    if (s.cards?.length)
      lines.push(
        "Research cards already on the user's panel:",
        ...s.cards.map(
          (c) =>
            `- ${c.kind} "${c.title}"${c.verdict ? ` (${c.verdict})` : ''}: ${c.bullets.join('; ')}${c.source ? ` [${c.source.name} ${c.source.url}]` : ''}`,
        ),
      );
    const pending = s.actions.filter((a) => a.status === 'pending' && a.kind === 'mine');
    if (pending.length)
      lines.push("Pending actions on the user's panel:", ...pending.map((a) => `- ${a.title}`));
    if (fresh.length) {
      let tx = fresh
        .map((l) => `[${formatMeetingClock(l.at)} ${meetingSpeakerLabel(l, s.voices)}] ${l.text}`)
        .join('\n');
      if (tx.length > MAX_PROMPT_TRANSCRIPT_CHARS)
        tx = `…${tx.slice(-MAX_PROMPT_TRANSCRIPT_CHARS)}`;
      lines.push('New transcript since your last turn:', tx);
    }
    lines.push('</system-reminder>', '');
    return lines.join('\n');
  }

  /** Stop timers (host shutdown). Meetings stay on disk. */
  dispose(): void {
    for (const rt of this.runtimes.values()) {
      this.disarmTimer(rt);
    }
  }

  // ---- internals ----

  /** One analysis pass if there is anything new. Exposed for tests. */
  async tick(chatId: string): Promise<void> {
    const rt = this.load(chatId);
    if (!rt || rt.state.status !== 'live') return;
    await this.enqueue(rt, () => this.analyse(chatId, rt, false));
    // Also when there was nothing new to analyse: lines held back by the throttle are still waiting.
    this.maybeResearch(chatId, rt);
  }

  /** Repairs mis-heard names in the lines not yet analysed. A failure throws: the pass is retried. */
  private async correctLines(chatId: string, rt: Runtime): Promise<void> {
    if (!this.deps.correct) return;
    const from = Math.max(rt.analysedUpTo, rt.correctedUpTo);
    const upTo = rt.state.transcript.length;
    const lines = rt.state.transcript.slice(from, upTo);
    if (lines.length === 0) return;
    const out = await this.deps.correct({
      chatId,
      glossary: this.deps.glossary?.() ?? [],
      context: {
        now: rt.state.now?.headline ?? null,
        topics: rt.state.topics.map((t) => t.title),
      },
      before: rt.state.transcript.slice(Math.max(0, from - 5), from).map((l) => l.text),
      lines: lines.map((l) => ({ speaker: meetingSpeakerLabel(l, rt.state.voices), text: l.text })),
    });
    if (out.length !== lines.length)
      throw new MeetingError(`correction returned ${out.length} lines for ${lines.length}`);
    lines.forEach((l, i) => {
      const fixed = out[i] as string;
      const found = nameFixes(l.text, fixed);
      if (found.length > 0) {
        const have = rt.state.nameFixes ?? [];
        for (const f of found)
          if (!have.some((x) => x.from === f.from && x.to === f.to)) have.push(f);
        rt.state.nameFixes = have.slice(-NAME_FIX_LIMIT);
      }
      l.text = fixed;
    });
    rt.correctedUpTo = upTo;
  }

  private async analyse(chatId: string, rt: Runtime, final: boolean): Promise<void> {
    if (
      rt.state.transcript.length - rt.analysedUpTo === 0 &&
      !(final && rt.state.summary === null && rt.state.transcript.length > 0)
    ) {
      return;
    }
    const upTo = rt.state.transcript.length;
    try {
      await this.correctLines(chatId, rt);
      const newLines = rt.state.transcript.slice(rt.analysedUpTo, upTo);
      const raw = await this.deps.analyse({
        chatId,
        previous: { now: rt.state.now, topics: rt.state.topics, actions: rt.state.actions },
        newLines: newLines.map((l) => ({
          clock: formatMeetingClock(l.at),
          speaker: meetingSpeakerLabel(l, rt.state.voices),
          text: l.text,
        })),
        final,
        elapsedMs: meetingElapsedMs(rt.state, this.now()),
        myNotes: rt.state.myNotes ?? '',
        prompts: this.deps.prompts(),
      });
      const a = MeetingAnalysis.parse(raw);
      this.merge(rt, a, final, newLines[0]?.at);
      rt.analysedUpTo = upTo;
      rt.state.error = null;
    } catch (err) {
      rt.state.error = `analysis failed: ${(err as Error).message}`;
      this.deps.logger.error({ chatId, err: (err as Error).message }, 'meeting: analysis failed');
    }
    this.commit(chatId, rt);
  }

  private merge(rt: Runtime, a: MeetingAnalysis, final: boolean, batchStart?: number): void {
    const s = rt.state;
    const elapsed = meetingElapsedMs(s, this.now());
    // A topic arose in the lines this pass was given, so its start lies between
    // the first of them and now. The model misreads clocks (a 27:15 point in a
    // 17:xx meeting), so an `atSeconds` outside that window is pulled into it.
    const startOf = (atSeconds: number | undefined): number => {
      if (atSeconds === undefined) return elapsed;
      const lo = Math.min(batchStart ?? 0, elapsed);
      return Math.min(Math.max(atSeconds * 1000, lo), elapsed);
    };
    if (!final && META_TEXT.test(`${a.now.headline} ${a.now.bullets.join(' ')}`))
      throw new MeetingError(`analysis returned model commentary: ${a.now.headline}`);
    s.now = final ? s.now : a.now;
    for (const t of a.topics) {
      const existing = t.id ? s.topics.find((x) => x.id === t.id) : undefined;
      const at = startOf(t.atSeconds);
      // Tom's own words are fixed input: a later pass never rewrites them.
      if (existing?.fixed) continue;
      if (existing) {
        existing.title = t.title;
        existing.points = t.points;
        existing.decided = t.decided ?? existing.decided;
      } else {
        s.topics.push({
          id: this.newId(),
          at,
          title: t.title,
          points: t.points,
          decided: t.decided ?? false,
        });
      }
    }
    // Points read oldest first however the model or an edit left them.
    s.topics.sort((x, y) => x.at - y.at);
    for (const v of a.voices ?? []) {
      const name = v.name.trim();
      if (name === '' || s.voices?.[String(v.voice)] !== undefined) continue;
      if (!s.transcript.some((l) => l.voice === v.voice)) continue;
      s.voices = { ...s.voices, [String(v.voice)]: name };
    }
    const norm = (x: string): string => x.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const act of a.actions) {
      if (s.actions.some((x) => norm(x.title) === norm(act.title))) continue;
      s.actions.push({
        id: this.newId(),
        kind: act.kind,
        ...(act.owner !== undefined ? { owner: act.owner } : {}),
        title: act.title,
        why: act.why,
        at: act.atSeconds !== undefined ? act.atSeconds * 1000 : meetingElapsedMs(s, this.now()),
        status: 'pending',
      });
    }
    if (final) {
      if (!a.summary) throw new MeetingError('final analysis returned no summary');
      if (META_TEXT.test(`${a.summary.headline} ${a.summary.bullets.join(' ')}`)) {
        // Nothing new to add since the last pass is a normal ending: the
        // summary is what the meeting already found, not an error.
        s.summary = {
          headline: s.now?.headline ?? s.topics[0]?.title ?? 'Meeting ended',
          bullets: s.topics.map((t) => t.title),
        };
        return;
      }
      s.summary = a.summary as MeetingSummary;
    }
  }

  private enqueue(rt: Runtime, job: () => Promise<void>): Promise<void> {
    const next = rt.chain.then(job);
    rt.chain = next.catch(() => undefined);
    return next;
  }

  private requireStatus(chatId: string, status: MeetingState['status']): Runtime {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting`);
    if (rt.state.status !== status) {
      throw new MeetingError(`chat ${chatId}'s meeting is ${rt.state.status}, not ${status}`);
    }
    return rt;
  }

  private armTimer(chatId: string, rt: Runtime): void {
    this.disarmTimer(rt);
    const set = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    rt.timer = set(() => {
      void this.tick(chatId).catch((err: unknown) =>
        this.deps.logger.error({ chatId, err: (err as Error).message }, 'meeting: tick crashed'),
      );
    }, this.intervalMs(rt));
  }

  /** A test-injected interval wins; otherwise the meeting's own setting. */
  private intervalMs(rt: Runtime): number {
    if (this.deps.intervalMs !== undefined) return this.deps.intervalMs;
    const secs = rt.state.settings?.analyseSeconds;
    return secs !== undefined ? secs * 1000 : MEETING_ANALYSE_INTERVAL_MS;
  }

  private disarmTimer(rt: Runtime): void {
    if (rt.timer === undefined) return;
    (this.deps.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout)))(rt.timer);
    rt.timer = undefined;
  }

  private file(chatId: string): string {
    return join(this.deps.dir, `${chatId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  }

  private load(chatId: string): Runtime | undefined {
    const hit = this.runtimes.get(chatId);
    if (hit) return hit;
    let raw: string;
    try {
      raw = readFileSync(this.file(chatId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    // A corrupt meeting file is loud: it is the only copy of the transcript.
    const parsed = JSON.parse(raw) as {
      state: unknown;
      analysedUpTo: number;
      deliveredUpTo: number;
      researchedUpTo?: number;
    };
    const state = MeetingState.parse(parsed.state);
    const rt: Runtime = {
      state,
      timer: undefined,
      analysedUpTo: parsed.analysedUpTo,
      deliveredUpTo: parsed.deliveredUpTo,
      correctedUpTo: parsed.analysedUpTo,
      researchedUpTo: parsed.researchedUpTo ?? parsed.analysedUpTo,
      lastResearchAt: 0,
      researching: undefined,
      chain: Promise.resolve(),
      txChain: Promise.resolve(),
    };
    this.runtimes.set(chatId, rt);
    // A host restart finds the meeting `live` with no audio coming: park it as
    // paused rather than pretending it is still listening.
    if (rt.state.status === 'live') {
      rt.state.elapsedBaseMs = meetingElapsedMs(rt.state, this.now());
      delete rt.state.resumedAt;
      rt.state.status = 'paused';
    }
    return rt;
  }

  private commit(chatId: string, rt: Runtime): void {
    // The provisional Now: whatever has been said that the notes do not cover yet.
    const unanalysed = rt.state.transcript.slice(rt.analysedUpTo);
    const text = unanalysed.map((l) => l.text).join(' ');
    rt.state.live = rt.state.status === 'ended' || text === '' ? null : text.slice(-MAX_LIVE_CHARS);
    const f = this.file(chatId);
    const tmp = `${f}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        state: rt.state,
        analysedUpTo: rt.analysedUpTo,
        deliveredUpTo: rt.deliveredUpTo,
        researchedUpTo: rt.researchedUpTo,
      }),
    );
    renameSync(tmp, f);
    this.deps.emit({ type: 'meeting.state', chatId, meeting: structuredClone(rt.state) });
  }
}
