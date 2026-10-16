// AI tool-run summariser (spec/14 § Main chat panel — "Tool runs collapse to
// one row").
//
// A collapsed run of tool calls should read like a line of a progress log —
// "Set up the project locally", "Searched the web for Haiku pricing" — not "9
// tool calls". When a run closes, a cheap one-shot Claude query (Haiku) reads
// the calls plus the prose around them and writes that line. The host stamps
// it into the stream as `chat.tool_run_summary`.
//
// NO FALLBACK: a failure — no account with credit, SDK error, timeout, empty
// reply — THROWS, and the host stamps the failure itself, so the surface marks
// the run as unsummarised instead of quietly showing something else.

import type { SdkBackend } from './sdkBackend.js';
import type { RunOnAccountWithCredit } from './accountFailover.js';
import type { Logger } from 'pino';
import { cutAt } from './textClean.js';

/** Cheap + fast model for the one-shot summariser (same as titleGen/statusGen). */
export const TOOL_RUN_MODEL = 'claude-haiku-4-5-20251001';

const TOOL_RUN_TIMEOUT_MS = 30_000;
/** Each call spawns a harness process; a busy turn must not spawn dozens at once. */
const MAX_CONCURRENT = 2;
/** The row is one line. */
const MAX_SUMMARY_LEN = 80;
const MAX_CALLS = 40;
const ARGS_SNIPPET_LEN = 300;
const OUTCOME_SNIPPET_LEN = 160;

export interface ToolRunCall {
  tool: string;
  args: unknown;
  /** The call's result came back as an error. Absent while no result has arrived. */
  failed?: boolean;
  /** A short clip of the error text, only for a failed call. */
  outcome?: string;
}

export interface GenerateToolRunSummaryInput {
  chatId: string;
  folder: string;
  calls: ToolRunCall[];
  /** The run is still going: write what is happening NOW, not what happened. */
  live?: boolean;
}

export interface MakeToolRunSummarizerOptions {
  sdkBackend: SdkBackend;
  /** The host's AI-call gate (spec/10-auth.md § Backend credentials). */
  runOnAccountWithCredit: RunOnAccountWithCredit;
  logger?: Logger;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${cutAt(t, max - 1)}…` : t;
}

function describeCall(call: ToolRunCall): string {
  let args: string;
  try {
    args = JSON.stringify(call.args ?? {});
  } catch {
    args = String(call.args);
  }
  const failure =
    call.failed === true
      ? ` [FAILED${call.outcome ? `: ${clip(call.outcome, OUTCOME_SNIPPET_LEN)}` : ''}]`
      : '';
  return `- ${call.tool} ${clip(args, ARGS_SNIPPET_LEN)}${failure}`;
}

export function buildToolRunPrompt(input: GenerateToolRunSummaryInput): string {
  const calls = input.calls.slice(0, MAX_CALLS).map(describeCall);
  if (input.calls.length > MAX_CALLS) calls.push(`- …and ${input.calls.length - MAX_CALLS} more`);
  if (input.live === true) {
    return [
      'An AI agent is in the middle of making tool calls. Write the short status',
      'line a chat shows the user while it works, judging only from the calls below.',
      '',
      'The calls so far, in order:',
      ...calls,
      '',
      'Say what the agent is doing right now, in 2 to 6 words, present continuous,',
      'sentence case, ending in an ellipsis character — e.g. "Looking at the picture…",',
      '"Searching the web for Haiku pricing…", "Setting up the project…".',
      'Name the subject in plain words, not the tools or file ids: never "Running Bash"',
      'or "Reading 01M4N7ZF-image.png".',
      'Reply with the line only: no quotes, no markdown.',
    ].join('\n');
  }
  return [
    'A batch of tool calls was just made. Write the one-line label',
    'a transcript shows for the collapsed batch, like a line in a progress log,',
    'judging only from the calls below.',
    '',
    'The calls, in order:',
    ...calls,
    '',
    'Say what the batch was FOR, in 3 to 8 words, past tense, sentence case —',
    'e.g. "Set up the project locally", "Searched the web for Haiku pricing",',
    '"Found where tool rows are grouped", "Checked why the deploy failed".',
    'Name the subject, not the tools: never "ran commands" or "read files".',
    'A call marked FAILED did not do its job: never say a failed call succeeded.',
    'If the batch was mostly failures, say it tried, e.g. "Tried to file a Jira ticket".',
    'Reply with the label only: no quotes, no markdown, no trailing full stop.',
  ].join('\n');
}

/** First non-empty line, stripped of quotes/markdown/trailing stop, capped. */
export function parseToolRunSummary(raw: string): string | null {
  const first = (raw.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  const cleaned = first
    .replace(/^[-*#>\s]+/, '')
    .replace(/^["'“‘`]+|["'”’`]+$/g, '')
    .replace(/\*\*/g, '')
    .replace(/(?<!…)[.\s]+$/, '')
    .trim();
  if (cleaned === '') return null;
  return cleaned.length > MAX_SUMMARY_LEN ? `${cutAt(cleaned, MAX_SUMMARY_LEN - 1)}…` : cleaned;
}

export function makeToolRunSummarizer(
  opts: MakeToolRunSummarizerOptions,
): (input: GenerateToolRunSummaryInput) => Promise<string> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < MAX_CONCURRENT) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  return async function summarizeToolRun(input: GenerateToolRunSummaryInput): Promise<string> {
    await acquire();
    try {
      const summary = await opts.runOnAccountWithCredit(
        `tool run summary ${input.chatId}`,
        async (accessToken) => {
          const abortController = new AbortController();
          const timer = setTimeout(() => abortController.abort(), TOOL_RUN_TIMEOUT_MS);
          try {
            let finalText = '';
            let deltaText = '';
            for await (const env of opts.sdkBackend.run({
              prompt: buildToolRunPrompt(input),
              inferenceProfile: 'classifier',
              cwd: input.folder,
              resumeSessionId: undefined,
              abortController,
              oauthAccessToken: accessToken,
              model: TOOL_RUN_MODEL,
              permissionMode: 'bypassPermissions',
            })) {
              if (env.type === 'assistant' && env.content) finalText += env.content;
              else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
              else if (env.type === 'error') {
                throw new Error(env.errorMessage ?? 'tool run summary: SDK error envelope');
              }
            }
            const parsed = parseToolRunSummary(finalText !== '' ? finalText : deltaText);
            if (parsed === null) throw new Error('the model returned an empty summary');
            return parsed;
          } finally {
            clearTimeout(timer);
          }
        },
      );
      if (summary === null) throw new Error('no Claude account with credit could answer');
      return summary;
    } finally {
      release();
    }
  };
}
