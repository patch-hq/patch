// Budgeted, deterministic provider-switch handoff (spec/04 § Provider
// switches — "Handoff budget"; design in spec/plans/2026-10-20-model-handoff.md).
//
// Pure planning only: given a chat's track and the TARGET model's window, pick
// how much of the track the target receives and build the handoff ledger from
// Patch's own log. Nothing here calls a model, so it works when the source
// provider is down or rate limited. NO silent truncation: every plan says what
// was carried, what was left behind, and an oversized request is refused
// before it is sent.

import type { TrackEntry } from './nativeReconstruct.js';
import { estimateTokens } from './nativeReconstruct.js';

/** Share of the available input a handoff may fill; the rest is growth room for the turn itself. */
export const HANDOFF_FILL = 0.6;
/** Estimates are chars/4; real tokenizers drift, so every estimate is inflated before comparing. */
export const ESTIMATE_SAFETY = 1.25;
/** Recent-window sizes (track entries) tried in order, widest first. */
export const RECENT_WINDOWS = [400, 120, 40, 12] as const;

export interface HandoffBudgetInput {
  /** Target model's context window (tokens), from the catalogue — never guessed. */
  contextWindow: number;
  /** System prompt + project instructions the target will receive. */
  instructionsTokens: number;
  /** Serialized tool schemas the target will receive. */
  toolsTokens: number;
  /** Max output the request reserves (or the model's own cap). */
  outputTokens: number;
  /** Headroom as a share of the window (default 5%). */
  marginShare?: number;
}

/** Tokens left for conversation input, after instructions, tools, output and margin. */
export function availableInputTokens(b: HandoffBudgetInput): number {
  const margin = Math.ceil(b.contextWindow * (b.marginShare ?? 0.05));
  return Math.max(
    0,
    b.contextWindow - b.instructionsTokens - b.toolsTokens - b.outputTokens - margin,
  );
}

export interface HandoffLedger {
  /** Seq range of the track this ledger summarises — where `patch_history` can read the rest. */
  fromSeq: number;
  toSeq: number;
  /** The last user message, byte-exact. Also sent as the turn's own input; never trimmed. */
  latestInstruction: string | null;
  filesChanged: string[];
  validation: { command: string; ok: boolean; seq: number }[];
  openTodos: string[];
}

const VALIDATION_RE = /\b(test|vitest|jest|pytest|lint|tsc|typecheck|build|verify|playwright)\b/i;

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/** Deterministic ledger from the log: same track in, identical ledger out. */
export function buildLedger(track: readonly TrackEntry[]): HandoffLedger {
  const files = new Set<string>();
  const calls = new Map<string, { command: string; seq: number }>();
  const validation: HandoffLedger['validation'] = [];
  let todos: string[] = [];
  let latest: string | null = null;
  for (const { record, event } of track) {
    if (event.type === 'chat.message' && event.role === 'user') latest = event.content;
    else if (event.type === 'chat.tool_call') {
      const a = asRecord(event.args);
      if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(event.tool)) {
        const p = a['file_path'] ?? a['notebook_path'];
        if (typeof p === 'string') files.add(p);
      } else if (event.tool === 'Bash' && typeof a['command'] === 'string') {
        if (VALIDATION_RE.test(a['command'])) {
          calls.set(event.callId, { command: a['command'].slice(0, 200), seq: record.seq });
        }
      } else if (event.tool === 'TodoWrite' && Array.isArray(a['todos'])) {
        todos = (a['todos'] as unknown[])
          .map(asRecord)
          .filter((t) => t['status'] !== 'completed' && typeof t['content'] === 'string')
          .map((t) => t['content'] as string);
      }
    } else if (event.type === 'chat.tool_result') {
      const c = calls.get(event.callId);
      if (c) validation.push({ ...c, ok: event.isError !== true });
    }
  }
  return {
    fromSeq: track[0]?.record.seq ?? -1,
    toSeq: track.at(-1)?.record.seq ?? -1,
    latestInstruction: latest,
    filesChanged: [...files].sort(),
    validation,
    openTodos: todos,
  };
}

/** The ledger as the text block the target reads. The source chat id + seq range tells it where older detail lives. */
export function renderLedger(
  chatId: string,
  ledger: HandoffLedger,
  carriedFromSeq: number,
  state: { permissionMode?: string; branch?: string; narrative?: string | null },
): string {
  const lines = [
    `[Handoff from an earlier session of chat ${chatId}]`,
    `Earlier history (seq ${ledger.fromSeq}–${carriedFromSeq - 1}) is not included; read it on demand with the patch_history tool (chat ${chatId}).`,
  ];
  if (state.permissionMode) lines.push(`Permission mode: ${state.permissionMode}`);
  if (state.branch) lines.push(`Branch: ${state.branch}`);
  if (ledger.filesChanged.length)
    lines.push(`Files changed:\n${ledger.filesChanged.map((f) => `- ${f}`).join('\n')}`);
  if (ledger.validation.length) {
    lines.push(
      `Validation run:\n${ledger.validation.map((v) => `- ${v.ok ? 'passed' : 'FAILED'}: ${v.command} (seq ${v.seq})`).join('\n')}`,
    );
  }
  if (ledger.openTodos.length)
    lines.push(`Outstanding:\n${ledger.openTodos.map((t) => `- ${t}`).join('\n')}`);
  lines.push(
    state.narrative
      ? `Summary by the previous model:\n${state.narrative}`
      : 'No model-written summary is available; rely on the facts above and the recent turns.',
  );
  return lines.join('\n\n');
}

export type HandoffPlan =
  | {
      ok: true;
      /** Entries handed over verbatim (the recent window), in order. */
      carried: TrackEntry[];
      /** First seq in `carried`; everything before it is reachable only via history. */
      carriedFromSeq: number;
      /** Entries left behind. 0 means the whole track fits (full reconstruction). */
      omittedEntries: number;
      ledger: HandoffLedger;
      /** Estimated tokens of carried + ledger + the latest instruction, inflated by the safety factor. */
      estimatedTokens: number;
      availableTokens: number;
    }
  | {
      ok: false;
      code: 'handoff_too_large';
      message: string;
      availableTokens: number;
      neededTokens: number;
    };

function inflated(tokens: number): number {
  return Math.ceil(tokens * ESTIMATE_SAFETY);
}

/**
 * Choose what the target receives. Full track if it fits within `HANDOFF_FILL`
 * of the available input; otherwise the widest recent window that does, plus
 * the ledger. If even the narrowest window + ledger + the latest instruction
 * cannot fit, the plan fails — the caller must say so, never send it.
 * `latestInstruction` is not trimmed under any circumstance.
 */
export function planHandoff(
  chatId: string,
  track: readonly TrackEntry[],
  budget: HandoffBudgetInput,
  opts: {
    latestInstruction: string;
    permissionMode?: string;
    branch?: string;
    narrative?: string | null;
    maxTokensOverride?: number;
  },
): HandoffPlan {
  const available = Math.min(availableInputTokens(budget), opts.maxTokensOverride ?? Infinity);
  const cap = Math.floor(available * HANDOFF_FILL);
  const instructionTokens = inflated(Math.ceil(opts.latestInstruction.length / 4));
  const ledger = buildLedger(track);
  const fullTokens = inflated(estimateTokens(track)) + instructionTokens;
  if (fullTokens <= cap) {
    return {
      ok: true,
      carried: [...track],
      carriedFromSeq: track[0]?.record.seq ?? 0,
      omittedEntries: 0,
      ledger,
      estimatedTokens: fullTokens,
      availableTokens: available,
    };
  }
  let needed = Infinity;
  for (const n of RECENT_WINDOWS) {
    const carried = alignToTurnStart(track, Math.max(0, track.length - n));
    const carriedFromSeq = carried[0]?.record.seq ?? (track.at(-1)?.record.seq ?? -1) + 1;
    const ledgerText = renderLedger(chatId, ledger, carriedFromSeq, opts);
    const tokens =
      inflated(estimateTokens(carried) + Math.ceil(ledgerText.length / 4)) + instructionTokens;
    needed = Math.min(needed, tokens);
    if (tokens <= cap) {
      return {
        ok: true,
        carried,
        carriedFromSeq,
        omittedEntries: track.length - carried.length,
        ledger,
        estimatedTokens: tokens,
        availableTokens: available,
      };
    }
  }
  // Last resort tier: ledger and instruction alone, no verbatim turns.
  const bare = renderLedger(chatId, ledger, (track.at(-1)?.record.seq ?? -1) + 1, opts);
  const bareTokens = inflated(Math.ceil(bare.length / 4)) + instructionTokens;
  if (bareTokens <= cap) {
    return {
      ok: true,
      carried: [],
      carriedFromSeq: (track.at(-1)?.record.seq ?? -1) + 1,
      omittedEntries: track.length,
      ledger,
      estimatedTokens: bareTokens,
      availableTokens: available,
    };
  }
  needed = Math.min(needed, bareTokens);
  return {
    ok: false,
    code: 'handoff_too_large',
    message: `The handoff needs about ${needed} tokens but the target model has ${cap} to spare. The history is untouched; pick a larger-window model or continue in a linked fresh chat.`,
    availableTokens: available,
    neededTokens: needed,
  };
}

/** Start the window at a user message so a tool result is never carried without its call. */
function alignToTurnStart(track: readonly TrackEntry[], from: number): TrackEntry[] {
  let i = from;
  while (i < track.length) {
    const e = track[i]!.event;
    if (e.type === 'chat.message' && e.role === 'user') break;
    i++;
  }
  return i >= track.length ? [] : track.slice(i);
}

/** What to do with a `context_length_exceeded` from the target: re-plan tighter once, never resend the same request. */
export function replanAfterOverflow(
  previous: { estimatedTokens: number; availableTokens: number },
  reportedLimit?: number,
): { maxTokensOverride: number } | null {
  const ceiling = Math.floor(previous.estimatedTokens * 0.5);
  if (ceiling < 1000) return null;
  return {
    maxTokensOverride: reportedLimit ? Math.min(ceiling, Math.floor(reportedLimit * 0.5)) : ceiling,
  };
}

/** Idempotency key for one handoff: a retry of the same switch reuses it, so the pending instruction is delivered once. */
export function handoffKey(
  chatId: string,
  branchId: string,
  fromSeq: number,
  targetModel: string,
): string {
  return `handoff:${chatId}:${branchId}:${fromSeq}:${targetModel}`;
}
