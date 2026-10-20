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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Logger } from 'pino';
import {
  meetingElapsedMs,
  formatMeetingClock,
  meetingSpeakerLabel,
  DEFAULT_MEETING_SETTINGS,
  MeetingSettings,
  applyMeetingNotesOp,
  type MeetingNotesOp,
  type MeetingAction,
  MeetingActionKind,
  type MeetingNow,
  MeetingState,
  type MeetingSummary,
  type MeetingTopic,
  type WireEvent,
} from '@patch/wire';

export const MEETING_ANALYSE_INTERVAL_MS = DEFAULT_MEETING_SETTINGS.analyseSeconds * 1000;
/** Longest provisional "Now" text kept on the state. */
const MAX_LIVE_CHARS = 300;
/** Transcript kept on the state; the oldest lines roll off past this. */
const MAX_TRANSCRIPT_LINES = 4000;
/** Cap on transcript fed into one analysis pass or one chat turn. */
const MAX_PROMPT_TRANSCRIPT_CHARS = 12_000;

/** A Them line this close in time to a You line can be the room's echo of it. */
const ECHO_WINDOW_MS = 30_000;
/** Bigram overlap above which two lines count as the same speech. */
const ECHO_SIMILARITY = 0.7;

const normSpeech = (x: string): string =>
  x
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function bigrams(x: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient on character bigrams: tolerant of a garbled or truncated copy. */
export function speechSimilarity(a: string, b: string): number {
  const x = normSpeech(a);
  const y = normSpeech(b);
  if (x === '' || y === '') return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  let shared = 0;
  for (const [g, n] of bx) shared += Math.min(n, by.get(g) ?? 0);
  return (2 * shared) / (Math.max(x.length - 1, 0) + Math.max(y.length - 1, 0));
}

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
    summary: z
      .object({ headline: z.string(), bullets: z.array(z.string()) })
      .nullable()
      .optional(),
  })
  .strict();
export type MeetingAnalysis = z.infer<typeof MeetingAnalysis>;

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
  /** The account's three editable instruction blocks, read fresh each pass. */
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
  analyse: (input: AnalyseInput) => Promise<MeetingAnalysis>;
  /**
   * Cheap pass over new transcript lines that repairs mis-heard names and places
   * before the notes are built. Returns one corrected text per input line.
   * Omitted: transcripts go to analysis as transcribed.
   */
  correct?: (input: CorrectInput) => Promise<string[]>;
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
  /** Serialises transcription and analysis so lines land in order. */
  chain: Promise<void>;
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
        transcript: [],
        error: null,
      },
      timer: undefined,
      analysedUpTo: 0,
      deliveredUpTo: 0,
      correctedUpTo: 0,
      chain: Promise.resolve(),
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

  resume(chatId: string): void {
    const rt = this.requireStatus(chatId, 'paused');
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
    await this.enqueue(rt, () => this.analyse(chatId, rt, true));
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
    return this.enqueue(rt, async () => {
      let text: string;
      try {
        text = (await this.deps.transcribe(wav)).trim();
      } catch (err) {
        rt.state.error = `transcription failed: ${(err as Error).message}`;
        this.deps.logger.error(
          { chatId, err: (err as Error).message },
          'meeting: transcription failed',
        );
        this.commit(chatId, rt);
        return;
      }
      if (text === '') return;
      const speaker = source === 'mic' ? 'you' : 'them';
      const isEcho = (l: { at: number; speaker: string; text: string }): boolean =>
        l.speaker !== speaker &&
        Math.abs(l.at - at) <= ECHO_WINDOW_MS &&
        speechSimilarity(l.text, text) >= ECHO_SIMILARITY;
      // In a room the mic and the call audio carry the same speech. The mic
      // copy is the clean one; the system copy is the echo and is dropped.
      if (speaker === 'them' && rt.state.transcript.some((l) => l.speaker === 'you' && isEcho(l))) {
        return;
      }
      if (speaker === 'you') {
        const echoed = rt.state.transcript.findIndex((l) => l.speaker === 'them' && isEcho(l));
        if (echoed >= 0 && echoed >= rt.analysedUpTo) rt.state.transcript.splice(echoed, 1);
      }
      rt.state.transcript.push(
        speaker === 'them' && speakerName
          ? { at, speaker, text, name: speakerName }
          : { at, speaker, text },
      );
      if (rt.state.transcript.length > MAX_TRANSCRIPT_LINES) {
        const drop = rt.state.transcript.length - MAX_TRANSCRIPT_LINES;
        rt.state.transcript.splice(0, drop);
        rt.analysedUpTo = Math.max(0, rt.analysedUpTo - drop);
        rt.deliveredUpTo = Math.max(0, rt.deliveredUpTo - drop);
        rt.correctedUpTo = Math.max(0, rt.correctedUpTo - drop);
      }
      rt.state.error = null;
      this.commit(chatId, rt);
    });
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

  // ---- actions ----

  /**
   * `do` runs an agent action in a linked chat and `chat` starts one on an
   * action of Tom's; both leave the row pointing at that chat. Someone else's
   * action never starts a chat. `dismiss` drops any row.
   */
  async decide(
    chatId: string,
    actionId: string,
    decision: 'do' | 'chat' | 'dismiss',
  ): Promise<void> {
    const rt = this.load(chatId);
    const action = rt?.state.actions.find((a) => a.id === actionId);
    if (!rt || !action) throw new MeetingError(`no action ${actionId} in chat ${chatId}`);
    if (action.status === 'dismissed' || action.status === 'done') {
      throw new MeetingError(`action ${actionId} is already ${action.status}`);
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

  /** The tray's checkbox. Turning it on starts every agent action already waiting. */
  async setAgentRunsActions(chatId: string, on: boolean): Promise<void> {
    const rt = this.load(chatId);
    if (!rt) throw new MeetingError(`chat ${chatId} has no meeting`);
    rt.state.agentRunsActions = on;
    this.commit(chatId, rt);
    if (on) await this.startWaitingAgentActions(chatId, rt);
  }

  private async startWaitingAgentActions(chatId: string, rt: Runtime): Promise<void> {
    for (const a of rt.state.actions) {
      if (a.kind !== 'agent' || a.status !== 'pending') continue;
      try {
        await this.startActionChat(chatId, rt, a);
      } catch (err) {
        this.deps.logger.error(
          { chatId, actionId: a.id, err: (err as Error).message },
          'meeting: agent action did not start',
        );
        rt.state.error = `could not start "${a.title}": ${(err as Error).message}`;
        this.commit(chatId, rt);
      }
    }
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
      `A meeting is ${s.status} in this chat (running ${formatMeetingClock(meetingElapsedMs(s, this.now()))}). Answer questions about it from what follows; look things up and use your tools when asked. Do not take actions on other people\'s behalf unless the user asks.`,
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
            `- ${formatMeetingClock(t.at)} ${t.title}${t.decided ? ' (decided)' : ''}: ${t.points.join('; ')}`,
        ),
      );
    const pending = s.actions.filter((a) => a.status === 'pending' && a.kind === 'mine');
    if (pending.length)
      lines.push("Pending actions on the user's panel:", ...pending.map((a) => `- ${a.title}`));
    if (fresh.length) {
      let tx = fresh
        .map((l) => `[${formatMeetingClock(l.at)} ${meetingSpeakerLabel(l)}] ${l.text}`)
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
    for (const rt of this.runtimes.values()) this.disarmTimer(rt);
  }

  // ---- internals ----

  /** One analysis pass if there is anything new. Exposed for tests. */
  async tick(chatId: string): Promise<void> {
    const rt = this.load(chatId);
    if (!rt || rt.state.status !== 'live') return;
    await this.enqueue(rt, () => this.analyse(chatId, rt, false));
  }

  /** Repairs mis-heard names in the lines not yet analysed. A failure throws: the pass is retried. */
  private async correctLines(chatId: string, rt: Runtime): Promise<void> {
    if (!this.deps.correct) return;
    const from = Math.max(rt.analysedUpTo, rt.correctedUpTo);
    const lines = rt.state.transcript.slice(from);
    if (lines.length === 0) return;
    const out = await this.deps.correct({
      chatId,
      glossary: this.deps.glossary?.() ?? [],
      context: {
        now: rt.state.now?.headline ?? null,
        topics: rt.state.topics.map((t) => t.title),
      },
      before: rt.state.transcript.slice(Math.max(0, from - 5), from).map((l) => l.text),
      lines: lines.map((l) => ({ speaker: meetingSpeakerLabel(l), text: l.text })),
    });
    if (out.length !== lines.length)
      throw new MeetingError(`correction returned ${out.length} lines for ${lines.length}`);
    lines.forEach((l, i) => {
      l.text = out[i] as string;
    });
    rt.correctedUpTo = rt.state.transcript.length;
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
      const newLines = rt.state.transcript.slice(rt.analysedUpTo);
      const raw = await this.deps.analyse({
        chatId,
        previous: { now: rt.state.now, topics: rt.state.topics, actions: rt.state.actions },
        newLines: newLines.map((l) => ({
          clock: formatMeetingClock(l.at),
          speaker: meetingSpeakerLabel(l),
          text: l.text,
        })),
        final,
        elapsedMs: meetingElapsedMs(rt.state, this.now()),
        prompts: this.deps.prompts(),
      });
      const a = MeetingAnalysis.parse(raw);
      this.merge(rt, a, final);
      rt.analysedUpTo = upTo;
      rt.state.error = null;
    } catch (err) {
      rt.state.error = `analysis failed: ${(err as Error).message}`;
      this.deps.logger.error({ chatId, err: (err as Error).message }, 'meeting: analysis failed');
    }
    this.commit(chatId, rt);
    if (rt.state.agentRunsActions) await this.startWaitingAgentActions(chatId, rt);
  }

  private merge(rt: Runtime, a: MeetingAnalysis, final: boolean): void {
    const s = rt.state;
    if (!final && META_TEXT.test(`${a.now.headline} ${a.now.bullets.join(' ')}`))
      throw new MeetingError(`analysis returned model commentary: ${a.now.headline}`);
    s.now = final ? s.now : a.now;
    for (const t of a.topics) {
      const existing = t.id ? s.topics.find((x) => x.id === t.id) : undefined;
      const at = t.atSeconds !== undefined ? t.atSeconds * 1000 : meetingElapsedMs(s, this.now());
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
      if (META_TEXT.test(`${a.summary.headline} ${a.summary.bullets.join(' ')}`))
        throw new MeetingError(`final analysis returned model commentary: ${a.summary.headline}`);
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
    };
    const state = MeetingState.parse(parsed.state);
    const rt: Runtime = {
      state,
      timer: undefined,
      analysedUpTo: parsed.analysedUpTo,
      deliveredUpTo: parsed.deliveredUpTo,
      correctedUpTo: parsed.analysedUpTo,
      chain: Promise.resolve(),
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
      }),
    );
    renameSync(tmp, f);
    this.deps.emit({ type: 'meeting.state', chatId, meeting: structuredClone(rt.state) });
  }
}
