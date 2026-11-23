// Claude on Amazon Bedrock accounts in words (spec/10 § Spending caps): the
// month's estimated spend against the cap, when it resets, and where requests
// run. Settings → Usage and the composer's account picker read them alike.

import {
  bedrockCapResetsAt,
  bedrockSpentThisMonth,
  type BedrockRegionPrefix,
  type ClaudeBedrock,
} from '@patch/wire';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `$18.42`, or `$100` for whole dollars. */
export function formatUsd(n: number): string {
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

/** `$18.42 of $100`: this month's estimated spend against the cap. */
export function bedrockSpend(bedrock: ClaudeBedrock, now: number = Date.now()): string {
  return `${formatUsd(bedrockSpentThisMonth(bedrock, now))} of ${formatUsd(bedrock.monthlyCapUsd)}`;
}

/** `Dec 1`: when the cap resets, the first of next month (UTC, the month spend counts in). */
export function bedrockResets(now: number = Date.now()): string {
  const d = new Date(bedrockCapResetsAt(now));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The Requests run in chips, in the order the design draws them. */
export const PREFIX_ORDER: readonly BedrockRegionPrefix[] = [
  'auto',
  'eu',
  'us',
  'apac',
  'jp',
  'au',
  'global',
];

export const PREFIX_LABEL: Record<BedrockRegionPrefix, string> = {
  auto: 'Auto',
  us: 'US',
  eu: 'EU',
  apac: 'APAC',
  jp: 'Japan',
  au: 'Australia',
  global: 'Global',
};

/**
 * Where `auto` sends a region's requests, as Claude Code derives it from the
 * region's own geography; null when the region names none of them.
 */
export function derivedPrefix(region: string): BedrockRegionPrefix | null {
  const r = region.trim().toLowerCase();
  if (r.startsWith('us-')) return 'us';
  if (r.startsWith('eu-')) return 'eu';
  if (r.startsWith('ap-')) return 'apac';
  return null;
}

/** The Requests run in chip's words: `Auto (EU)` names where auto lands when it is known. */
export function prefixLabel(prefix: BedrockRegionPrefix, region: string): string {
  if (prefix !== 'auto') return PREFIX_LABEL[prefix];
  const derived = derivedPrefix(region);
  return derived === null ? 'Auto' : `Auto (${PREFIX_LABEL[derived]})`;
}
