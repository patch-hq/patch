// Claude on Amazon Bedrock: the month a spend counts in, and the cap
// (spec/10 § Spending caps). The server keeps the spend; the host checks the
// cap before a turn; surfaces draw the Monthly bar. One reading of the rules.

import type { ClaudeBedrock } from './events.js';

/** The calendar month, UTC, an instant falls in: `YYYY-MM`. */
export function bedrockMonth(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The first instant of the month after the one `at` falls in, UTC: when a cap resets. */
export function bedrockCapResetsAt(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** The account's estimated spend in the month `now` falls in; another month's reads as 0. */
export function bedrockSpentThisMonth(
  bedrock: Pick<ClaudeBedrock, 'spentUsd' | 'spentMonth'>,
  now: number,
): number {
  return bedrock.spentMonth === bedrockMonth(now) ? bedrock.spentUsd : 0;
}

/** Has this month's spend reached the cap? Then the account is limited until `bedrockCapResetsAt(now)`. */
export function bedrockAtCap(
  bedrock: Pick<ClaudeBedrock, 'spentUsd' | 'spentMonth' | 'monthlyCapUsd'>,
  now: number,
): boolean {
  return bedrockSpentThisMonth(bedrock, now) >= bedrock.monthlyCapUsd;
}
