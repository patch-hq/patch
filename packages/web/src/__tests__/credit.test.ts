import { describe, expect, it } from 'vitest';
import type { AccountUsageRow } from '../components/UsagePopover.js';
import {
  creditDefaultAccountId,
  firstInCreditAccountId,
  modelSpent,
  providerSpent,
  routableRows,
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

// spec/10 § Choosing an account, § Spending caps — the default and the
// "provider spent" greying count only accounts the strategy could pick for a
// chat on this host.
describe('credit with Bedrock accounts and auto off', () => {
  // 23 Nov 2026, inside the month the spend is for.
  const T = Date.UTC(2026, 10, 23, 12);
  const bedrock = (hostId: string, spentUsd: number) => ({
    hostId,
    awsProfile: 'work',
    awsRegion: 'eu-west-2',
    regionPrefix: 'eu' as const,
    monthlyCapUsd: 100,
    spentUsd,
    spentMonth: '2026-11',
  });
  const r = (
    accountId: string,
    usage: AccountUsageRow['usage'],
    extra: Partial<AccountUsageRow> = {},
  ): AccountUsageRow => ({ ...row('claude', accountId, usage), ...extra });
  const spentSub = r('sub', { session: { status: 'rejected' as const, resetsAt: T + 60_000 } });

  it('never defaults to an account with auto off', () => {
    const rows = [spentSub, r('manual', undefined, { auto: false })];
    expect(creditDefaultAccountId(rows, 'claude', T)).toBeNull();
    expect(firstInCreditAccountId(rows, 'claude', T)).toBeNull();
  });

  it('an account with auto off does not keep the provider in credit', () => {
    const rows = [spentSub, r('manual', undefined, { auto: false })];
    expect(providerSpent(rows, 'claude', new Set(), T)).toBe(true);
  });

  it('never defaults to a Bedrock account at its cap, and counts it as spent', () => {
    const rows = [spentSub, r('aws', undefined, { bedrock: bedrock('h1', 100) })];
    expect(creditDefaultAccountId(rows, 'claude', T)).toBeNull();
    expect(providerSpent(rows, 'claude', new Set(), T)).toBe(true);
    const under = [spentSub, r('aws', undefined, { bedrock: bedrock('h1', 40) })];
    expect(creditDefaultAccountId(under, 'claude', T)).toBe('aws');
    expect(providerSpent(under, 'claude', new Set(), T)).toBe(false);
  });

  it('counts a Bedrock account only for a chat on its own host', () => {
    const rows = [spentSub, r('aws', undefined, { bedrock: bedrock('h1', 0) })];
    expect(routableRows(rows, 'h1', T).map((x) => x.accountId)).toEqual(['sub', 'aws']);
    // On another host, or none chosen, it is not there to run on.
    for (const host of ['h2', null]) {
      const routable = routableRows(rows, host, T);
      expect(routable.map((x) => x.accountId)).toEqual(['sub']);
      expect(creditDefaultAccountId(routable, 'claude', T)).toBeNull();
      expect(providerSpent(routable, 'claude', new Set(), T)).toBe(true);
    }
  });

  it('leaves out auto-off and capped rows when routing', () => {
    const rows = [
      r('a', undefined),
      r('off', undefined, { auto: false }),
      r('capped', undefined, { bedrock: bedrock('h1', 100) }),
    ];
    expect(routableRows(rows, 'h1', T).map((x) => x.accountId)).toEqual(['a']);
  });
});

describe('creditRows: a chat locked to an account', () => {
  it('judges credit on the locked account alone, even with auto off', async () => {
    const { creditRows, providerSpent } = await import('../lib/credit.js');
    const now = Date.UTC(2026, 10, 23, 12);
    const spent = {
      accountId: 'sub',
      providerId: 'claude',
      backend: 'Claude',
      usage: { at: now, week: { status: 'rejected', utilization: 1, resetsAt: now + 86_400_000 } },
    } as never;
    const bedrock = {
      accountId: 'aws',
      providerId: 'claude',
      backend: 'Claude',
      auto: false,
      bedrock: {
        hostId: 'mac',
        awsProfile: 'dev',
        awsRegion: 'eu-west-1',
        regionPrefix: 'eu',
        monthlyCapUsd: 100,
        spentUsd: 1,
        spentMonth: '2026-11',
      },
    } as never;
    const none = new Set<never>();
    expect(providerSpent(creditRows([spent, bedrock], 'mac', null, now), 'claude', none, now)).toBe(
      true,
    );
    expect(
      providerSpent(creditRows([spent, bedrock], 'mac', 'aws', now), 'claude', none, now),
    ).toBe(false);
    // On another host the Bedrock lock is not this chat's account.
    expect(
      creditRows([spent, bedrock], 'box', 'aws', now).map(
        (r) => (r as { accountId: string }).accountId,
      ),
    ).toEqual(['sub']);
  });
});
