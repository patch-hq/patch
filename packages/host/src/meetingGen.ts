// The meeting-mode analysis pass (see meeting.ts): one cheap one-shot model
// call that reads the new transcript plus what the panel already shows and
// returns the updated Now / Discussed / Actions as JSON. Same shape as
// statusGen.ts, except a failure THROWS: the manager puts it on the panel.

import { z } from 'zod';
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
    'Reply with ONE JSON object and nothing else, with exactly these keys:',
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

/** First `{` to last `}` — models wrap JSON in prose or fences despite being told not to. */
export function parseMeetingAnalysis(raw: string): MeetingAnalysis {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new Error(`no JSON object in model reply: ${raw.slice(0, 120)}`);
  return MeetingAnalysis.parse(JSON.parse(raw.slice(start, end + 1)));
}

export function makeMeetingAnalyser(opts: {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  cwd: string;
  /** Read fresh each pass so a Settings change applies mid-meeting. */
  model: () => string;
}): (input: AnalyseInput) => Promise<MeetingAnalysis> {
  return async function analyse(input) {
    const result = await opts.runOnAccountWithCredit(
      `meeting ${input.chatId}`,
      async (accessToken) => {
        const abortController = new AbortController();
        const timer = setTimeout(
          () => abortController.abort(),
          meetingTimeoutMs(input.previous.topics.length),
        );
        try {
          let finalText = '';
          let deltaText = '';
          for await (const env of opts.sdkBackend.run({
            prompt: buildMeetingPrompt(input),
            inferenceProfile: 'classifier',
            cwd: opts.cwd,
            resumeSessionId: undefined,
            abortController,
            oauthAccessToken: accessToken,
            model: opts.model(),
            permissionMode: 'bypassPermissions',
          })) {
            if (env.type === 'assistant' && env.content) finalText += env.content;
            else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
            else if (env.type === 'error')
              throw new Error(env.errorMessage ?? 'meeting: SDK error envelope');
          }
          return finalText !== '' ? finalText : deltaText;
        } finally {
          clearTimeout(timer);
        }
      },
    );
    if (result === null || result === undefined)
      throw new Error('no account could run the meeting analysis');
    return parseMeetingAnalysis(result);
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
    `Reply with ONE JSON array of exactly ${input.lines.length} strings, the corrected text of each line in order, and nothing else.`,
  ].join('\n');
}

/** First `[` to last `]`, same tolerance as the notes parser. */
export function parseCorrections(raw: string, expected: number): string[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start)
    throw new Error(`no JSON array in correction reply: ${raw.slice(0, 120)}`);
  const out = z.array(z.string()).parse(JSON.parse(raw.slice(start, end + 1)));
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
    const result = await opts.runOnAccountWithCredit(
      `meeting correct ${input.chatId}`,
      async (accessToken) => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), MEETING_TIMEOUT_MS);
        try {
          let finalText = '';
          let deltaText = '';
          for await (const env of opts.sdkBackend.run({
            prompt: buildCorrectionPrompt(input),
            inferenceProfile: 'classifier',
            cwd: opts.cwd,
            resumeSessionId: undefined,
            abortController,
            oauthAccessToken: accessToken,
            model: opts.model(),
            permissionMode: 'bypassPermissions',
          })) {
            if (env.type === 'assistant' && env.content) finalText += env.content;
            else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
            else if (env.type === 'error')
              throw new Error(env.errorMessage ?? 'meeting: SDK error envelope');
          }
          return finalText !== '' ? finalText : deltaText;
        } finally {
          clearTimeout(timer);
        }
      },
    );
    if (result === null || result === undefined)
      throw new Error('no account could run the meeting correction');
    return parseCorrections(result, input.lines.length);
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
    'Reply with ONE JSON object and nothing else:',
    '{"cards":[{"kind":"explained | fact | answer","title":"","atSeconds":0,"bullets":[""],"verdict":"correct | off | unclear (kind fact only; omit for explained and answer)","source":{"name":"","url":""}}]}',
    'atSeconds is the transcript time in seconds that prompted the card.',
  ].join('\n');
}

export function parseResearch(raw: string): MeetingResearchResult {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new Error(`no JSON object in research reply: ${raw.slice(0, 120)}`);
  return MeetingResearchResult.parse(JSON.parse(raw.slice(start, end + 1)));
}

export function makeMeetingResearcher(opts: {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  cwd: string;
  /** Read fresh each pass so a Settings change applies mid-meeting. */
  model: () => string;
}): (input: ResearchInput) => Promise<MeetingResearchResult> {
  return async function research(input) {
    const result = await opts.runOnAccountWithCredit(
      `meeting research ${input.chatId}`,
      async (accessToken) => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), RESEARCH_TIMEOUT_MS);
        try {
          // Searching takes several turns: only the last message is the answer.
          let last = '';
          for await (const env of opts.sdkBackend.run({
            prompt: buildResearchPrompt(input),
            inferenceProfile: 'research',
            cwd: opts.cwd,
            resumeSessionId: undefined,
            abortController,
            oauthAccessToken: accessToken,
            model: opts.model(),
            permissionMode: 'bypassPermissions',
          })) {
            if (env.type === 'assistant' && env.content) last = env.content;
            else if (env.type === 'error')
              throw new Error(env.errorMessage ?? 'meeting: SDK error envelope');
          }
          return last;
        } finally {
          clearTimeout(timer);
        }
      },
    );
    if (result === null || result === undefined)
      throw new Error('no account could run the meeting research');
    return parseResearch(result);
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
    'Reply with ONE JSON object and nothing else:',
    '{"title":"short title of the meeting","sections":[{"heading":"","items":[{"text":"","mine":true}]}]}',
  ].join('\n');
}

export function parseWriteup(raw: string): MeetingWriteup {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new Error(`no JSON object in write-up reply: ${raw.slice(0, 120)}`);
  return MeetingWriteup.parse(JSON.parse(raw.slice(start, end + 1)));
}

export function makeMeetingWriteup(opts: {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  cwd: string;
  /** Read fresh each pass so a Settings change applies. */
  model: () => string;
}): (input: WriteupInput) => Promise<MeetingWriteup> {
  return async function writeup(input) {
    const result = await opts.runOnAccountWithCredit(
      `meeting write-up ${input.chatId}`,
      async (accessToken) => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), WRITEUP_TIMEOUT_MS);
        try {
          let finalText = '';
          let deltaText = '';
          for await (const env of opts.sdkBackend.run({
            prompt: buildWriteupPrompt(input),
            inferenceProfile: 'classifier',
            cwd: opts.cwd,
            resumeSessionId: undefined,
            abortController,
            oauthAccessToken: accessToken,
            model: opts.model(),
            permissionMode: 'bypassPermissions',
          })) {
            if (env.type === 'assistant' && env.content) finalText += env.content;
            else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
            else if (env.type === 'error')
              throw new Error(env.errorMessage ?? 'meeting: SDK error envelope');
          }
          return finalText !== '' ? finalText : deltaText;
        } finally {
          clearTimeout(timer);
        }
      },
    );
    if (result === null || result === undefined)
      throw new Error('no account could run the meeting write-up');
    return parseWriteup(result);
  };
}
