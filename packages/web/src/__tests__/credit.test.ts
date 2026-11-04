import { describe, expect, it } from 'vitest';
import type { AccountUsageRow } from '../components/UsagePopover.js';
import {
  creditDefaultAccountId,
  firstInCreditAccountId,
  modelSpent,
  providerSpent,
} from '../lib/credit.js';

const NOW = 1_000_000;
const blocked = { session: { status: 'rejected' as const, resetsAt: NOW + 60_000 } };
const open = { session: { status: 'allowed' as const, utilization: 0.2 } };

function row(
  providerId: 'claude' | 'codex',
  accountId: string,
  usage: AccountUsageRow['usage'],
): AccountUsageRow {
  return {
    key: `${providerId}:${accountId}`,
    providerId,
    accountId,
    label: accountId,
    backend: providerId,
    title: accountId,
    usage,
  };
}

describe('credit', () => {
  it('picks the first account that is not refusing work', () => {
    const rows = [row('claude', 'a', blocked), row('claude', 'b', open), row('claude', 'c', open)];
    expect(firstInCreditAccountId(rows, 'claude', NOW)).toBe('b');
  });

  it('returns null when every account of the provider is spent', () => {
    expect(firstInCreditAccountId([row('claude', 'a', blocked)], 'claude', NOW)).toBeNull();
  });

  it('treats an account nothing has read yet as available, not spent', () => {
    expect(firstInCreditAccountId([row('claude', 'a', undefined)], 'claude', NOW)).toBe('a');
    expect(providerSpent([row('claude', 'a', undefined)], 'claude', new Set(), NOW)).toBe(false);
  });

  it('marks a provider spent only when all its accounts are', () => {
    const both = [row('claude', 'a', blocked), row('claude', 'b', blocked)];
    expect(providerSpent(both, 'claude', new Set(), NOW)).toBe(true);
    expect(providerSpent([...both, row('claude', 'c', open)], 'claude', new Set(), NOW)).toBe(
      false,
    );
  });

  it('never marks a provider with an API key spent', () => {
    const rows = [row('codex', 'a', blocked)];
    expect(providerSpent(rows, 'codex', new Set(['codex']), NOW)).toBe(false);
  });

  it('greys a model by its own provider only', () => {
    const rows = [row('claude', 'a', blocked), row('codex', 'x', open)];
    expect(modelSpent('claude-opus-5-5', rows, new Set(), NOW)).toBe(true);
    expect(modelSpent('openai/gpt-5', rows, new Set(), NOW)).toBe(false);
  });

  it('defaults to the in-credit account only when a sibling is spent', () => {
    const mixed = [row('claude', 'a', blocked), row('claude', 'b', open)];
    expect(creditDefaultAccountId(mixed, 'claude', NOW)).toBe('b');
    const healthy = [row('claude', 'a', open), row('claude', 'b', open)];
    expect(creditDefaultAccountId(healthy, 'claude', NOW)).toBeNull();
    expect(creditDefaultAccountId([row('claude', 'a', blocked)], 'claude', NOW)).toBeNull();
  });
});
