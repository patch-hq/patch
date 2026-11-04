// The meeting-mode model passes (see meeting.ts): one-shot model calls that
// read the transcript and return the notes, name corrections, research cards
// or write-up. Each answer must match a schema the SDK makes the model fill, so
// there is no text to parse. A failure THROWS: the manager puts it on the panel.

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Logger } from 'pino';
import type { SdkBackend } from './sdkBackend.js';
import type { RunOnAccountWithCredit } from './accountFailover.js';
import {
  DEFAULT_MEETING_MODEL,
  formatMeetingClock,
  MEETING_CLEANUP_INSTRUCTIONS,
  MEETING_NOTES_FRAME,
  MEETING_RESEARCH_INSTRUCTIONS,
  MEETING_RESEARCH_RULES,
  MEETING_WRITEUP_INSTRUCTIONS,
  MeetingWriteup,
} from '@patch/wire';
import {
  MeetingAnalysis,
  MeetingResearchResult,
  type WriteupInput,
  type AnalyseInput,
  type CorrectInput,
  type ResearchInput,
} from './meeting.js';

export const MEETING_MODEL = DEFAULT_MEETING_MODEL;
const MEETING_TIMEOUT_MS = 60_000;
/** Every existing topic is sent back and rewritten each pass, so the pass grows with the notes. */
const MEETING_TIMEOUT_PER_TOPIC_MS = 2_000;
const MEETING_TIMEOUT_MAX_MS = 240_000;

export function meetingTimeoutMs(topicCount: number): number {
  return Math.min(
    MEETING_TIMEOUT_MAX_MS,
    MEETING_TIMEOUT_MS + topicCount * MEETING_TIMEOUT_PER_TOPIC_MS,
  );
}

/** The JSON schema a structured answer must match, from its zod schema. */
function schemaOf(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' });
  const { $schema: _drop, ...rest } = json as Record<string, unknown>;
  return rest;
}

interface StructuredRun {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  cwd: string;
  model: () => string;
}

/**
 * One model call whose answer must match `schema`: the SDK makes the model fill
 * it, so there is no text to dig JSON out of. NO FALLBACK: a run that ends
 * without a structured answer is an error.
 */
async function runStructured(
  opts: StructuredRun,
  what: string,
  prompt: string,
  schema: Record<string, unknown>,
  profile: 'classifier' | 'research',
  timeoutMs: number,
): Promise<unknown> {
  const result = await opts.runOnAccountWithCredit(what, async (accessToken) => {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      let structured: unknown;
      for await (const env of opts.sdkBackend.run({
        prompt,
        inferenceProfile: profile,
        outputSchema: schema,
        cwd: opts.cwd,
        resumeSessionId: undefined,
        abortController,
        oauthAccessToken: accessToken,
        model: opts.model(),
        permissionMode: 'bypassPermissions',
      })) {
        if (env.type === 'result' && env.structured !== undefined) structured = env.structured;
        else if (env.type === 'error')
          throw new Error(env.errorMessage ?? 'meeting: SDK error envelope');
      }
      return { structured };
    } finally {
      clearTimeout(timer);
    }
  });
  if (result === null || result === undefined) throw new Error(`no account could run the ${what}`);
  if (result.structured === undefined)
    throw new Error(`the ${what} ended without a structured answer`);
  return result.structured;
}

export function buildMeetingPrompt(input: AnalyseInput): string {
  const line = (l: AnalyseInput['newLines'][number]): string =>
    `[${l.clock} ${l.speaker}] ${l.text}`;
  const transcript = input.newLines.map(line).join('\n');
  return [
    ...MEETING_NOTES_FRAME,
    '',
    `Meeting time so far: ${formatMeetingClock(input.elapsedMs)}`,
    '',
    "Tom's own notes:",
    input.myNotes.trim() !== '' ? input.myNotes.trim() : '(none)',
    '',
    'Notes so far (JSON). A topic with "fixed":true was written or edited by Tom: treat it as given. Never return it',
    '(no update, no condensing) and do not repeat its content in any other topic.',
    'Notes so far (JSON):',
    JSON.stringify({
      now: input.previous.now,
      topics: input.previous.topics.map((t) => ({
        id: t.id,
        atSeconds: Math.round(t.at / 1000),
        title: t.title,
        points: t.points,
        decided: t.decided,
        ...(t.fixed ? { fixed: true } : {}),
      })),
      actions: input.previous.actions.map((a) => ({
        title: a.title,
        kind: a.kind,
        ...(a.owner !== undefined ? { owner: a.owner } : {}),
        status: a.status,
      })),
    }),
    '',
    ...(input.earlierLines.length > 0
      ? [
          'Earlier transcript (context only, already in the notes: read the new lines in light of it):',
          input.earlierLines.map(line).join('\n'),
          '',
        ]
      : []),
    'NEW transcript:',
    transcript !== ''
      ? transcript
      : '(none: everything said so far is already in the notes above. Do not comment on this; write the reply from the notes.)',
    '',
    'Answer in the given structure. The keys mean:',
    '{"now":{"headline":"","bullets":[""],"who":""},',
    ' "topics":[{"id":"existing topic id to update, or null for a new topic","title":"short","points":["short key points"],"decided":false,"atSeconds":0}],',
    ' "voices":[{"voice":2,"name":"only for a Them N voice whose name is clear"}],',
    ' "actions":[{"kind":"mine | other | agent","owner":"only for other: the speaker\'s name, or Everyone","title":"imperative, specific, e.g. Top up Sam\'s sandbox credit by £50","why":"who said what that prompted it","atSeconds":0}],',
    ` "summary":${input.final ? '{"headline":"one-line outcome","bullets":["decisions, actions and open questions counts and gist"]}' : 'null'}}`,
    '',
    'How to fill each key:',
    input.prompts.now,
    input.prompts.notes,
    input.prompts.actions,
    'atSeconds is the meeting time in seconds the topic or action arose, from the transcript clock. Never invent facts.',
  ].join('\n');
}

/**
 * The analysis answer, item by item: one action or topic the model got wrong
 * (an owner missing for someone else's action) is dropped and named in
 * `dropped`, rather than throwing away the whole pass and freezing the notes.
 * A wrong top level is still an error.
 */
export function parseMeetingAnalysis(raw: unknown): {
  analysis: MeetingAnalysis;
  dropped: string[];
} {
  if (typeof raw !== 'object' || raw === null) throw new Error('meeting analysis is not an object');
  const r = raw as Record<string, unknown>;
  const dropped: string[] = [];
  const shape = MeetingAnalysis.shape;
  const keep = <T>(key: string, item: z.ZodType<T>, list: unknown): T[] | undefined => {
    if (list === undefined || list === null) return undefined;
    if (!Array.isArray(list)) throw new Error(`meeting analysis ${key} is not a list`);
    const out: T[] = [];
    list.forEach((x, i) => {
      // A null field is the model saying "none": the same as leaving it out.
      const cleaned =
        typeof x === 'object' && x !== null
          ? Object.fromEntries(Object.entries(x).filter(([k, v]) => v !== null || k === 'id'))
          : x;
      const p = item.safeParse(cleaned);
      if (p.success) out.push(p.data);
      else dropped.push(`${key}[${i}]: ${p.error.issues.map((e) => e.message).join('; ')}`);
    });
    return out;
  };
  const topics = keep('topics', shape.topics.element, r['topics']) ?? [];
  const actions = keep('actions', shape.actions.element, r['actions']) ?? [];
  const voices = keep('voices', shape.voices.unwrap().element, r['voices']);
  const analysis = MeetingAnalysis.parse({
    now: r['now'],
    topics,
    actions,
    ...(voices !== undefined ? { voices } : {}),
    summary: r['summary'] ?? null,
  });
  return { analysis, dropped };
}

const MEETING_ANALYSIS_SCHEMA = schemaOf(MeetingAnalysis);

export function makeMeetingAnalyser(opts: {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  cwd: string;
  /** Read fresh each pass so a Settings change applies mid-meeting. */
  model: () => string;
  logger?: Logger;
}): (input: AnalyseInput) => Promise<MeetingAnalysis> {
  return async function analyse(input) {
    const raw = await runStructured(
      opts,
      `meeting analysis`,
      buildMeetingPrompt(input),
      MEETING_ANALYSIS_SCHEMA,
      'classifier',
      meetingTimeoutMs(input.previous.topics.length),
    );
    const { analysis, dropped } = parseMeetingAnalysis(raw);
    if (dropped.length > 0)
      opts.logger?.warn({ chatId: input.chatId, dropped }, 'meeting: analysis items dropped');
    return analysis;
  };
}

export function buildCorrectionPrompt(input: CorrectInput): string {
  return [
    ...MEETING_CLEANUP_INSTRUCTIONS,
    '',
    'Glossary (one per line; "Term: heard as, heard as" lists known mishearings):',
    input.glossary.length ? input.glossary.join('\n') : '(none)',
    '',
    `Meeting so far: ${input.context.now ?? '(not yet known)'}`,
    `Topics: ${input.context.topics.join('; ') || '(none yet)'}`,
    '',
    'Preceding lines, for context only (do not return these):',
    input.before.join('\n') || '(none)',
    '',
    'Lines to correct (JSON array of {speaker,text}):',
    JSON.stringify(input.lines),
    '',
    `Answer in the given structure: "lines" holds exactly ${input.lines.length} strings, the corrected text of each line in order.`,
  ].join('\n');
}

const Corrections = z.object({ lines: z.array(z.string()) }).strict();
const CORRECTIONS_SCHEMA = schemaOf(Corrections);

export function parseCorrections(raw: unknown, expected: number): string[] {
  const out = Corrections.parse(raw).lines;
  if (out.length !== expected)
    throw new Error(`correction returned ${out.length} lines, expected ${expected}`);
  return out;
}

export function makeMeetingCorrector(opts: {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  cwd: string;
  /** Read fresh each pass so a Settings change applies mid-meeting. */
  model: () => string;
}): (input: CorrectInput) => Promise<string[]> {
  return async function correct(input) {
    const raw = await runStructured(
      opts,
      'meeting correction',
      buildCorrectionPrompt(input),
      CORRECTIONS_SCHEMA,
      'classifier',
      MEETING_TIMEOUT_MS,
    );
    return parseCorrections(raw, input.lines.length);
  };
}

const RESEARCH_TIMEOUT_MS = 180_000;

export function buildResearchPrompt(input: ResearchInput): string {
  const transcript = input.lines.map((l) => `[${l.clock} ${l.speaker}] ${l.text}`).join('\n');
  return [
    ...MEETING_RESEARCH_INSTRUCTIONS,
    '',
    `Meeting so far: ${input.context.now ?? '(not yet known)'}`,
    `Already researched (do not repeat these): ${input.existing.join('; ') || '(none)'}`,
    '',
    'NEW transcript:',
    transcript,
    '',
    ...MEETING_RESEARCH_RULES,
    '',
    'Answer in the given structure. The keys mean:',
    '{"cards":[{"kind":"explained | fact | answer","title":"","atSeconds":0,"bullets":[""],"verdict":"correct | off | unclear (kind fact only; omit for explained and answer)","source":{"name":"","url":""}}]}',
    'atSeconds is the transcript time in seconds that prompted the card.',
  ].join('\n');
}

export function parseResearch(raw: unknown): MeetingResearchResult {
  return MeetingResearchResult.parse(raw);
}

const RESEARCH_SCHEMA = schemaOf(MeetingResearchResult);

export function makeMeetingResearcher(opts: {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  cwd: string;
  /** Read fresh each pass so a Settings change applies mid-meeting. */
  model: () => string;
}): (input: ResearchInput) => Promise<MeetingResearchResult> {
  return async function research(input) {
    const raw = await runStructured(
      opts,
      'meeting research',
      buildResearchPrompt(input),
      RESEARCH_SCHEMA,
      'research',
      RESEARCH_TIMEOUT_MS,
    );
    return parseResearch(raw);
  };
}

const WRITEUP_TIMEOUT_MS = 180_000;

export function buildWriteupPrompt(input: WriteupInput): string {
  const transcript = input.lines.map((l) => `[${l.clock} ${l.speaker}] ${l.text}`).join('\n');
  return [
    ...MEETING_WRITEUP_INSTRUCTIONS,
    '',
    `Meeting: ${input.date}, ${input.durationMinutes} min.`,
    `Points the live notes picked out (for emphasis only; the transcript is the source): ${input.points.join('; ') || '(none)'}`,
    '',
    "Tom's notes:",
    input.myNotes.trim() !== '' ? input.myNotes : '(none)',
    '',
    'Transcript:',
    transcript !== '' ? transcript : '(empty: write from the notes alone)',
    '',
    'Answer in the given structure. The keys mean:',
    '{"title":"short title of the meeting","sections":[{"heading":"","items":[{"text":"","mine":true}]}]}',
  ].join('\n');
}

export function parseWriteup(raw: unknown): MeetingWriteup {
  return MeetingWriteup.parse(raw);
}

const WRITEUP_SCHEMA = schemaOf(MeetingWriteup);

export function makeMeetingWriteup(opts: {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  cwd: string;
  /** Read fresh each pass so a Settings change applies. */
  model: () => string;
}): (input: WriteupInput) => Promise<MeetingWriteup> {
  return async function writeup(input) {
    const raw = await runStructured(
      opts,
      'meeting write-up',
      buildWriteupPrompt(input),
      WRITEUP_SCHEMA,
      'classifier',
      WRITEUP_TIMEOUT_MS,
    );
    return parseWriteup(raw);
  };
}
