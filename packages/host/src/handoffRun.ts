// The host half of the budgeted provider-switch handoff (spec/04 § Handoff
// budget; planning core in handoffPlan.ts). Where a model's window comes from,
// what a plan is worth to the target, and the words each stage says.

import { createHash } from 'node:crypto';
import type { TrackEntry } from './nativeReconstruct.js';
import { renderLedger, type HandoffBudgetInput, type HandoffPlan } from './handoffPlan.js';

/** Allowance for the harness's own built-in prompt, on top of the prompts the host adds. */
export const HARNESS_INSTRUCTION_ALLOWANCE_TOKENS = 8_000;
/** Allowance for the harness's tool schemas plus the patch MCP tools. */
export const HARNESS_TOOLS_ALLOWANCE_TOKENS = 12_000;
/** Output headroom when the catalogue names no cap for the model. */
export const DEFAULT_OUTPUT_TOKENS = 32_000;
/**
 * Planning window for a model nothing has reported a window for yet (a Codex
 * model before its first turn: `model/list` carries none). Deliberately small;
 * the divider says the window was assumed, and an overflow re-plans tighter.
 */
export const UNASSUMED_WINDOW_TOKENS = 128_000;

export interface ModelLimit {
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** What the catalogue and the harnesses have reported about each model's limits. */
export class ModelLimits {
  private readonly byModel = new Map<string, ModelLimit>();

  note(model: string, limit: ModelLimit): void {
    // Nothing usable reported: record nothing, so `get` still says "unknown".
    if (!((limit.contextWindow ?? 0) > 0) && !((limit.maxOutputTokens ?? 0) > 0)) return;
    const prior = this.byModel.get(model) ?? {};
    this.byModel.set(model, {
      ...prior,
      ...(limit.contextWindow !== undefined && limit.contextWindow > 0
        ? { contextWindow: limit.contextWindow }
        : {}),
      ...(limit.maxOutputTokens !== undefined && limit.maxOutputTokens > 0
        ? { maxOutputTokens: limit.maxOutputTokens }
        : {}),
    });
  }

  get(model: string | null | undefined): ModelLimit | undefined {
    return model ? this.byModel.get(model) : undefined;
  }
}

export interface HandoffBudgetResult {
  budget: HandoffBudgetInput;
  /** False when the window was assumed rather than reported. */
  windowKnown: boolean;
}

/** Window, instructions, tools and output for the target, from the catalogue and the host's own prompts. */
export function budgetFor(
  limit: ModelLimit | undefined,
  prompts: { systemPrompt?: string | undefined; toolsPrompt?: string | undefined },
): HandoffBudgetResult {
  const promptTokens = Math.ceil(
    ((prompts.systemPrompt?.length ?? 0) + (prompts.toolsPrompt?.length ?? 0)) / 4,
  );
  return {
    windowKnown: limit?.contextWindow !== undefined,
    budget: {
      contextWindow: limit?.contextWindow ?? UNASSUMED_WINDOW_TOKENS,
      instructionsTokens: promptTokens + HARNESS_INSTRUCTION_ALLOWANCE_TOKENS,
      toolsTokens: HARNESS_TOOLS_ALLOWANCE_TOKENS,
      outputTokens: limit?.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
    },
  };
}

export function instructionHash(instruction: string): string {
  return createHash('sha256').update(instruction, 'utf8').digest('hex');
}

/** Input-token reports more than this far from the estimate are flagged. */
export const VERIFY_FLAG_RATIO = 2;

export function estimateIsOff(estimated: number, reported: number | null): boolean {
  if (reported === null || estimated === 0) return false;
  const ratio = reported / estimated;
  return ratio > VERIFY_FLAG_RATIO || ratio < 1 / VERIFY_FLAG_RATIO;
}

type OkPlan = Extract<HandoffPlan, { ok: true }>;

/**
 * The track the target receives for a plan: the carried window, led (when
 * anything was left behind) by the ledger as a user-framed context block — the
 * same framing the compact path uses, since the first turn must be a user's.
 */
export function trackForPlan(
  chatId: string,
  plan: OkPlan,
  state: { permissionMode?: string; branch?: string; narrative?: string | null },
  at: number,
): TrackEntry[] {
  if (plan.omittedEntries === 0) return plan.carried;
  const seq = (plan.carried[0]?.record.seq ?? plan.carriedFromSeq) - 1;
  const ledger: TrackEntry = {
    record: { seq, at: plan.carried[0]?.record.at ?? at },
    event: {
      type: 'chat.message',
      chatId,
      role: 'user',
      content: renderLedger(chatId, plan.ledger, plan.carriedFromSeq, state),
      seq,
    },
  };
  return [ledger, ...plan.carried];
}

/** The divider's words — one wording for every surface. */
export function dividerCopy(o: {
  model: string;
  carried: number;
  total: number;
  estimatedTokens: number;
  availableTokens: number;
  windowKnown: boolean;
  summary: boolean;
  summaryNote?: string;
  replanned: boolean;
}): string {
  const n = (v: number): string => v.toLocaleString('en-GB');
  const parts = [
    o.carried === o.total
      ? `Continued on ${o.model} — carried all ${n(o.total)} entries`
      : `Continued on ${o.model} — carried ${n(o.carried)} of ${n(o.total)} entries; older history readable on demand`,
    `~${n(o.estimatedTokens)} of ${n(o.availableTokens)} tokens${o.windowKnown ? '' : ' (window assumed)'}`,
  ];
  if (o.replanned) parts.push('re-planned smaller after the first attempt was too large');
  if (o.carried !== o.total)
    parts.push(
      o.summary
        ? 'with a model-written summary'
        : `no model-written summary (${o.summaryNote ?? 'not requested'})`,
    );
  return parts.join(' · ');
}
