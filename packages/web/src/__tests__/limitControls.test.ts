import { describe, it, expect } from 'vitest';
import { limitControls, formatSpanShort } from '../lib/limitControls.js';
import type { AccountUsageRow } from '../components/UsagePopover.js';

const NOW = Date.parse('2026-10-21T14:44:00Z');
const OUT = { session: { status: 'rejected' as const, resetsAt: NOW + 3_600_000 } };
const row = (providerId: 'claude' | 'codex', accountId: string, out: boolean): AccountUsageRow => ({
  key: `${providerId}:${accountId}`,
  providerId,
  accountId,
  label: accountId,
  backend: providerId,
  title: accountId,
  usage: out ? OUT : undefined,
});
const base = {
  now: NOW,
  resetsAt: NOW + 16 * 60_000,
  currentAccountId: 'work',
  currentProviderId: 'claude',
  overageBlocked: true,
};

describe('limitControls', () => {
  it('Send waits for the reset and says when', () => {
    const c = limitControls({ ...base, rows: [row('claude', 'work', true)] });
    expect(c.send.enabled).toBe(false);
    expect(c.send.reason).toMatch(/^Available at /);
  });
  it('Send is the main button after the reset when nothing else can help', () => {
    const c = limitControls({ ...base, resetsAt: NOW - 1, rows: [row('claude', 'work', true)] });
    expect(c.send.enabled).toBe(true);
    expect(c.main).toBe('send');
  });
  it('another account with usage left enables Change account, which is the main button', () => {
    const c = limitControls({
      ...base,
      rows: [row('claude', 'work', true), row('claude', 'home', false)],
    });
    expect(c.account.options.map((o) => o.id)).toEqual(['home']);
    expect(c.main).toBe('account');
  });
  it('no other account has usage left -> disabled with the reason', () => {
    const c = limitControls({
      ...base,
      rows: [row('claude', 'work', true), row('claude', 'home', true)],
    });
    expect(c.account).toMatchObject({ enabled: false, reason: 'No other account has usage left' });
  });
  it('lists every connected provider with usage left, not a fixed pair', () => {
    const c = limitControls({
      ...base,
      rows: [row('claude', 'work', true), row('codex', 'gpt', false)],
    });
    expect(c.provider.options.map((o) => o.id)).toEqual(['codex']);
    expect(c.main).toBe('provider');
  });
  it('providers all out -> disabled with the reason', () => {
    const c = limitControls({
      ...base,
      rows: [row('claude', 'work', true), row('codex', 'gpt', true)],
    });
    expect(c.provider).toMatchObject({
      enabled: false,
      reason: 'No other provider has usage left',
    });
  });
  it('extra usage is a way there only while it is off', () => {
    expect(limitControls({ ...base, rows: [] }).extraUsage.enabled).toBe(true);
    expect(limitControls({ ...base, overageBlocked: false, rows: [] }).extraUsage).toMatchObject({
      enabled: false,
      reason: 'Extra usage is already on',
    });
  });
  it('formats short spans', () => {
    expect(formatSpanShort(16 * 60_000)).toBe('16 min');
    expect(formatSpanShort(125 * 60_000)).toBe('2 h 5 min');
    expect(formatSpanShort(50 * 3_600_000)).toBe('2 d 2 h');
  });
});
