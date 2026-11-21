import { describe, it, expect } from 'vitest';
import { limitOf, noUsageText } from '../lib/accountLimits.js';
import { connectDoneText, isGuideItemDone } from '../lib/guide.js';
import type { AccountUsageRow } from '../components/UsagePopover.js';

const NOW = Date.parse('2026-11-17T10:00:00Z');
const RESET = NOW + 3 * 86_400_000;
const row = (id: string, usage: AccountUsageRow['usage']): AccountUsageRow => ({
  key: `claude-code:${id}`,
  providerId: 'claude',
  accountId: id,
  label: id,
  backend: 'Claude',
  title: id,
  usage,
});
const OUT = { week: { status: 'rejected' as const, resetsAt: RESET } };

describe('limitOf', () => {
  it('is null with no accounts, no reading, or one account still usable', () => {
    expect(limitOf([], NOW)).toBeNull();
    expect(limitOf([row('a', undefined)], NOW)).toBeNull();
    expect(limitOf([row('a', OUT), row('b', undefined)], NOW)).toBeNull();
  });
  it('reports the earliest reset when every account is out', () => {
    const sooner = { week: { status: 'rejected' as const, resetsAt: RESET - 3_600_000 } };
    expect(limitOf([row('a', OUT), row('b', sooner)], NOW)).toEqual({ until: RESET - 3_600_000 });
  });
  it('says so plainly, with the reset', () => {
    expect(noUsageText({ until: RESET }, NOW)).toMatch(
      /^Connected, but this account has no usage left until /,
    );
    expect(noUsageText({ until: null }, NOW)).toBe('Connected, but this account has no usage left');
  });
});

describe('guide connect step', () => {
  it('is not done when connected but out of usage', () => {
    const p = { connected: true, limited: { until: RESET }, hasChat: false };
    expect(isGuideItemDone('connect', p)).toBe(false);
    expect(connectDoneText(p).line).not.toMatch(/You can send messages/);
  });
  it('is done when connected with usage left', () => {
    const p = { connected: true, limited: null, hasChat: false };
    expect(isGuideItemDone('connect', p)).toBe(true);
    expect(connectDoneText(p).line).toMatch(/You can send messages/);
  });
});
