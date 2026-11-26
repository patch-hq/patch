// AI goal evaluator (spec/04 § Goals).
//
// After a turn settles on a chat with an active goal, a cheap one-shot query
// reads the visible transcript so far against the goal's condition and
// returns a verdict: `not_met` (another turn follows, guided by the reason),
// `refused` (the agent declined; another turn follows, until it has declined
// too often), `blocked` (the agent says it cannot go on without the user; it
// shares the refused streak, so the goal stops pushing after the same limit), `met` (the goal clears, the normal done notification rings), or
// `impossible` (the goal clears, the chat needs the user). Modelled on
// `statusGen.ts`/`titleGen.ts`'s one-shot shape. One model judges every chat,
// whichever provider the chat itself runs on: the judge reads a transcript, so
// it has nothing to do with the chat's model, and it is chosen in Settings →
// Goals.
//
// NO FALLBACK: any failure — no credential, SDK error, timeout, unparseable
// reply — resolves to null and the host leaves the goal exactly as it was,
// logged; the next turn's settle tries again.

import {
  DEFAULT_GOAL_EVAL_PROMPT,
  DEFAULT_GOAL_MODEL,
  DEFAULT_GOAL_STRINGENCY,
  isEndpointModel,
  tailCodePoints,
} from '@patch/wire';
import type { GoalStringency } from '@patch/wire';
import { sdkCredential, type SdkBackend } from './sdkBackend.js';
import type { OAuthCheckResult } from './chatRunner.js';
import type { Logger } from 'pino';
import { cutAt } from './textClean.js';

/** The judge model until Settings names another. */
export const GOAL_EVAL_MODEL = DEFAULT_GOAL_MODEL;

/** Abort a hung evaluator call so it never leaks a warm SDK query. */
const GOAL_EVAL_TIMEOUT_MS = 20_000;

/** Level 3 reads files over several tool steps, so it gets longer. */
const GOAL_EVAL_INVESTIGATE_TIMEOUT_MS = 180_000;

/** Hard cap on the returned reason — a safety bound only; the chat shows the whole reason. */
const MAX_REASON_LEN = 2000;

export type GoalVerdict = 'met' | 'not_met' | 'refused' | 'blocked' | 'impossible';

export type GoalOnTrack = 'on_track' | 'off_track';

export interface GoalEvalResult {
  verdict: GoalVerdict;
  reason: string;
  /** Present only when the evaluation was a check-in (`GoalEvalInput.checkIn`). */
  onTrack?: GoalOnTrack;
  /** Why the goal is on or off track; present with `onTrack`. */
  onTrackReason?: string;
}

export interface GoalEvalInput {
  chatId: string;
  condition: string;
  /** Rendered `role: content` transcript, oldest first, already bounded by the caller. */
  transcript: string;
  turnsEvaluated: number;
  folder: string;
  /** Host-verified state of this chat's background tasks/monitors (never the agent's own claim). */
  background: string;
  /** The latest tool calls and their results, rendered by `renderToolActivity`: the evidence the text transcript lacks. */
  recentTools?: string;
  /** Everything the user has asked for in this chat, so the scope survives the transcript being cut. */
  userScope: string;
  /** The agent's latest message, verbatim: where it states what is done and what blocks it. */
  agentStatement: string;
  /** This evaluation is also a check-in: the reply must say whether the goal is on track. */
  checkIn?: boolean;
  /**
   * The chat's own model. A chat on a model endpoint is judged on that model,
   * never on a paid one the user did not choose (spec/02 § Provider adapters).
   */
  chatModel?: string;
  /**
   * Second opinion on an "impossible" verdict: the reason it was given. The
   * reply is `blocked` when the only obstacle is something the user must do or
   * supply (or time passing), `impossible` when no one could ever meet the goal.
   */
  reviewImpossible?: { reason: string };
}

export interface GoalJudgeSettings {
  /** The judge's instructions (Settings → Goals). */
  prompt: string;
  /** The model that judges every chat, whichever provider the chat runs on. */
  model: string;
  /** How far the judge trusts the agent (Settings → Goals); absent means the default. */
  stringency?: GoalStringency;
}

export interface MakeGoalEvaluatorOptions {
  /** Read per evaluation, so an edit in Settings applies to the next turn. Absent means the defaults. */
  settings?: () => GoalJudgeSettings;
  sdkBackend: SdkBackend;
  /** The host's own model-aware OAuth gate (mirrors chatRunner's `resolveOAuth`). */
  resolveOAuth: (model?: string) => OAuthCheckResult | Promise<OAuthCheckResult>;
  logger?: Logger;
}

/**
 * Coerce a raw model reply into `{ verdict, reason }`, or null when nothing
 * usable remains. The model is asked for a JSON object (same fenced-code
 * tolerance as `hookCheck.ts`'s `parseHookOutcome`).
 */
export function parseGoalVerdict(raw: string): GoalEvalResult | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const unfenced = trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const verdict = obj['verdict'];
  if (
    verdict !== 'met' &&
    verdict !== 'not_met' &&
    verdict !== 'refused' &&
    verdict !== 'blocked' &&
    verdict !== 'impossible'
  )
    return null;
  const rawReason = obj['reason'];
  if (typeof rawReason !== 'string' || rawReason.trim() === '') return null;
  let reason = rawReason.trim().replace(/\s+/g, ' ');
  if (reason.length > MAX_REASON_LEN) reason = `${cutAt(reason, MAX_REASON_LEN - 1).trimEnd()}…`;
  const onTrack = obj['onTrack'];
  if (onTrack === undefined) return { verdict, reason };
  if (onTrack !== 'on_track' && onTrack !== 'off_track') return null;
  const rawOnTrackReason = obj['onTrackReason'];
  if (typeof rawOnTrackReason !== 'string' || rawOnTrackReason.trim() === '') return null;
  let onTrackReason = rawOnTrackReason.trim().replace(/\s+/g, ' ');
  if (onTrackReason.length > MAX_REASON_LEN)
    onTrackReason = `${cutAt(onTrackReason, MAX_REASON_LEN - 1).trimEnd()}…`;
  return { verdict, reason, onTrack, onTrackReason };
}

/** What the judge is told about how far to trust the agent, per stringency level. */
function stringencySection(level: GoalStringency): string[] {
  if (level === 1)
    return [
      "TRUST: take the agent's latest message at its word. It says what is done and what is not; judge the goal from that statement and the scope above.",
      '',
    ];
  if (level === 3)
    return [
      "TRUST: none. Do not accept the agent's word, or the conversation's, that anything is done. " +
        'You have read-only tools in the working folder (Read, Grep, Glob). Open every file, ' +
        'path and resource the goal depends on or the agent mentions, and check in detail that it ' +
        'exists and does what the goal needs. Judge "met" only for what you have verified yourself; ' +
        'anything you could not check is not_met, and the reason says what to show.',
      '',
    ];
  return [];
}

export const IMPOSSIBLE_REVIEW_PROMPT = `A previous judge ruled a stated GOAL impossible and gave a reason. Check that reason.
Decide exactly one of:
- "blocked" — the only thing stopping the goal is something the user must do or supply
  (a decision, a credential, access, a physical action, a change to their own
  settings or hours) or a point in time that will pass. The goal is achievable once
  they act or the time comes. Name exactly what the user needs to do or supply.
- "impossible" — no one could ever satisfy the goal: it contradicts itself, depends on
  something that no longer exists, or is out of reach even with the user's help.
When in doubt between the two, answer "blocked": a goal must never be ended just
because it was waiting on the user.`;

function buildReviewPrompt(input: GoalEvalInput, reason: string): string {
  return [
    IMPOSSIBLE_REVIEW_PROMPT,
    '',
    `GOAL: ${input.condition}`,
    '',
    `REASON GIVEN FOR "impossible": ${reason}`,
    '',
    'WHAT THE USER ASKED FOR:',
    input.userScope,
    '',
    "THE AGENT'S LATEST MESSAGE:",
    input.agentStatement,
    '',
    'CONVERSATION SO FAR (oldest first):',
    input.transcript,
    '',
    'Reply with ONLY a JSON object of the shape {"verdict":"blocked"|"impossible","reason":"..."}. ' +
      'For "blocked" the reason says what the user needs to do or supply, as an instruction. No prose outside the JSON.',
  ].join('\n');
}

function buildPrompt(input: GoalEvalInput, instructions: string, level: GoalStringency): string {
  if (input.reviewImpossible) return buildReviewPrompt(input, input.reviewImpossible.reason);
  return [
    instructions.trim(),
    '',
    `Turns evaluated against this goal so far (including this one): ${input.turnsEvaluated}.`,
    '',
    `GOAL: ${input.condition}`,
    '',
    'BACKGROUND TASKS (verified by the host, not the agent):',
    input.background,
    'If the agent says it is waiting on a monitor or background task, that wait is only valid ' +
      'when a task above is running. If none is, the wait is invalid: judge not_met and tell ' +
      "the agent to check the finished task's output and carry on.",
    '',
    'WHAT THE USER ASKED FOR (this, and only this, is the scope of the work; it is complete even if the conversation below is cut short):',
    input.userScope,
    '',
    "THE AGENT'S LATEST MESSAGE (any blockers it states are given here):",
    input.agentStatement,
    '',
    'Judge the goal against the scope above. Work the user did not ask for is not unmet: ' +
      'if the agent reports a problem that lies outside that scope (for example a design bug a ' +
      'test turned up) and says it is leaving it, that does not make the goal not_met. ' +
      'If it names a blocker that stops the in-scope work and only the user can clear it, ' +
      'judge blocked with that blocker as the reason (impossible is only for a goal no one could ever meet), rather than not_met.',
    '',
    "Judge from the whole record: the conversation, the tool activity and the agent's latest message. " +
      'Never say no work has been done when any of them shows work; say what is done and name only what remains. ' +
      'If everything left waits on an outside party (an approval, a reply, a delivery) and the agent has said so, ' +
      'that is a valid pause: judge blocked and name what is awaited, rather than not_met, and never tell the agent to repeat an outward-facing action already taken.',
    '',
    ...stringencySection(level),
    ...(level === 1 || !input.recentTools
      ? []
      : [
          'RECENT TOOL ACTIVITY (recorded by the host, oldest first; this is the evidence of work done, and the conversation below holds only the messages):',
          input.recentTools,
          '',
        ]),
    ...(level === 1 ? [] : ['CONVERSATION SO FAR (oldest first):', input.transcript, '']),
    ...(input.checkIn
      ? [
          'This is also a CHECK-IN. Besides the verdict, say whether the work is on track to meet ' +
            'the goal: "on_track" when it is making real progress towards it, "off_track" when it ' +
            'has drifted, is going in circles or is stuck. Give the reason in "onTrackReason".',
          '',
        ]
      : []),
    'Reply with ONLY a JSON object of the shape ' +
      (input.checkIn
        ? '{"verdict":"met"|"not_met"|"refused"|"blocked"|"impossible","reason":"...","onTrack":"on_track"|"off_track","onTrackReason":"..."}'
        : '{"verdict":"met"|"not_met"|"refused"|"blocked"|"impossible","reason":"..."}') +
      '. No prose outside the JSON.',
  ].join('\n');
}

/**
 * Build the host's `evaluateGoal` dependency from the SDK backend + OAuth
 * gate. The returned function is resilient: it wraps the whole one-shot in
 * try/catch, aborts after `GOAL_EVAL_TIMEOUT_MS`, and always resolves to a
 * parsed `{ verdict, reason }` or null (never throws, never hangs).
 */
export function makeGoalEvaluator(
  opts: MakeGoalEvaluatorOptions,
): (input: GoalEvalInput) => Promise<GoalEvalResult | null> {
  return async function evaluateGoal(input: GoalEvalInput): Promise<GoalEvalResult | null> {
    const judge = opts.settings?.() ?? {
      prompt: DEFAULT_GOAL_EVAL_PROMPT,
      model: GOAL_EVAL_MODEL,
    };
    const level = judge.stringency ?? DEFAULT_GOAL_STRINGENCY;
    const timeoutMs = level === 3 ? GOAL_EVAL_INVESTIGATE_TIMEOUT_MS : GOAL_EVAL_TIMEOUT_MS;
    const model = isEndpointModel(input.chatModel) ? input.chatModel! : judge.model;
    const auth = await opts.resolveOAuth(model);
    if (!auth.ok) {
      opts.logger?.warn(
        { chatId: input.chatId, reason: auth.reason },
        'goal eval: no credential available',
      );
      return null;
    }
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      let finalText = '';
      let deltaText = '';
      for await (const env of opts.sdkBackend.run({
        prompt: buildPrompt(input, judge.prompt, level),
        inferenceProfile: level === 3 ? 'investigator' : 'classifier',
        cwd: input.folder,
        resumeSessionId: undefined,
        abortController,
        ...sdkCredential(auth),
        model,
        permissionMode: 'bypassPermissions',
      })) {
        if (env.type === 'assistant' && env.content) finalText += env.content;
        else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
        else if (env.type === 'error') {
          throw new Error(env.errorMessage ?? 'goal eval: SDK error envelope');
        }
      }
      return parseGoalVerdict(finalText !== '' ? finalText : deltaText);
      // No catch here for the same reason `titleGen`/`statusGen` have none: a
      // failure belongs to the outer catch below, which never guesses at what
      // a spent account vs. a real error means — it just returns null either way.
    } catch (err) {
      if (abortController.signal.aborted) {
        opts.logger?.warn({ chatId: input.chatId }, `goal eval: no answer within ${timeoutMs}ms`);
        return null;
      }
      opts.logger?.warn({ chatId: input.chatId, err: (err as Error).message }, 'goal eval failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The user's own messages, oldest first, bounded from the front so the latest always survive. */
export function renderUserScope(
  messages: ReadonlyArray<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  maxChars = 3000,
): string {
  const text = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n\n');
  if (text === '') return '(no user messages)';
  return text.length > maxChars ? `…\n${tailCodePoints(text, maxChars)}` : text;
}

/** The agent's most recent message, bounded. */
export function renderAgentStatement(
  messages: ReadonlyArray<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  maxChars = 2000,
): string {
  const last = [...messages].reverse().find((m) => m.role === 'assistant')?.content;
  if (last === undefined || last === '') return '(the agent has not replied yet)';
  return last.length > maxChars ? `…\n${tailCodePoints(last, maxChars)}` : last;
}

/** Render a bounded `role: content` transcript for the evaluator prompt. */
export function renderGoalTranscript(
  messages: ReadonlyArray<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  maxChars = 6000,
): string {
  const lines = messages.map((m) => `${m.role}: ${m.content}`);
  let text = lines.join('\n\n');
  if (text.length > maxChars) text = `…\n${tailCodePoints(text, maxChars)}`;
  return text;
}

export interface ToolActivityEntry {
  name: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${cutAt(flat, max - 1).trimEnd()}…` : flat;
}

export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((b) =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text'
          ? String((b as { text?: unknown }).text ?? '')
          : '',
      )
      .filter((t) => t !== '')
      .join(' ');
  }
  return JSON.stringify(value) ?? '';
}

/** Render the latest tool calls, one line each, bounded; newest last. */
export function renderToolActivity(
  entries: ReadonlyArray<ToolActivityEntry>,
  maxChars = 5000,
): string {
  if (entries.length === 0) return '(no tool calls yet)';
  const lines = entries.map(
    (e) =>
      `- ${e.name}(${clip(textOf(e.args), 160)}) ${e.isError ? 'FAILED' : '->'} ${clip(textOf(e.result), 400)}`,
  );
  const text = lines.join('\n');
  return text.length > maxChars ? `…\n${tailCodePoints(text, maxChars)}` : text;
}
