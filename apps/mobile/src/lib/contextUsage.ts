// A chat's context reading as the ring and its sheet draw it (spec/14 §
// Composer — context ring; mirrors web's `summariseContext`).

import type { ChatContextUsage } from '@patch/wire';

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (Math.round(n / 1000) < 1000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`;
}

export interface ContextSummary {
  fraction: number;
  percent: string;
  tokens: string;
  level: 'ok' | 'warn' | 'blocked' | 'unknown';
}

/**
 * Null until the host has measured the chat: an empty ring would read as an
 * empty window, which nobody has measured. Tokens without a window read `?` — a
 * fraction of an unknown whole is not a figure.
 */
export function summariseContext(ctx: ChatContextUsage | null | undefined): ContextSummary | null {
  if (!ctx) return null;
  if (ctx.windowTokens === undefined) {
    return {
      fraction: 0,
      percent: '?',
      tokens: `${formatTokens(ctx.usedTokens)} / ?`,
      level: 'unknown',
    };
  }
  const fraction = Math.min(1, ctx.usedTokens / ctx.windowTokens);
  return {
    fraction,
    percent: `${Math.round(fraction * 100)}%`,
    tokens: `${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.windowTokens)}`,
    level: fraction >= 0.9 ? 'blocked' : fraction >= 0.7 ? 'warn' : 'ok',
  };
}
