// spec/10 § Choosing an account, § Spending caps — where a turn may run when
// Bedrock accounts are in play. A capped Bedrock account is never handed out:
// no provider would refuse a turn on it, so "let the provider say no" would
// spend past the cap. A lock to an account held on another host is refused,
// while a lock to an account since removed still follows the strategy.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRotation, type FailoverAccount } from '../src/accountFailover.js';
import {
  BEDROCK_CAP_REACHED,
  bedrockCapRefusal,
  bedrockCappedWith,
  pendingBedrockSpendUsd,
} from '../src/bedrockAccounts.js';
import { Outbox } from '../src/outbox.js';

const NOW = Date.UTC(2026, 10, 23, 12);

describe('a capped Bedrock account', () => {
  it('is not run for a chat locked to it, even as the fallback', () => {
    const r = new AccountRotation(() => NOW);
    const accounts: FailoverAccount[] = [
      { id: 'oauth', connected: true, auto: false },
      { id: 'bed', connected: true, auto: false, capped: true },
    ];
    r.markExhausted('bed', BEDROCK_CAP_REACHED, Date.UTC(2026, 11, 1), undefined, 'limit');
    expect(r.usableAccount(accounts, { preferred: 'bed' })).toBeUndefined();
    expect(r.effectiveAccount(accounts, { preferred: 'bed' })).toBeUndefined();
    expect(r.startTurn(accounts, { preferred: 'bed' })).toBeUndefined();
  });

  it('is refused even before the host has recorded it as spent', () => {
    // Pending spend took it past the cap a moment ago; no exhaustion record yet.
    const r = new AccountRotation(() => NOW);
    const accounts: FailoverAccount[] = [{ id: 'bed', connected: true, capped: true }];
    expect(r.effectiveAccount(accounts, { preferred: 'bed' })).toBeUndefined();
    expect(r.effectiveAccount(accounts)).toBeUndefined();
  });

  it('with every subscription spent, an Automatic turn goes to a spent subscription, never the capped account', () => {
    const r = new AccountRotation(() => NOW);
    const accounts: FailoverAccount[] = [
      { id: 'bed', connected: true, capped: true },
      { id: 'oauth', connected: true },
    ];
    r.markExhausted('bed', BEDROCK_CAP_REACHED, Date.UTC(2026, 11, 1), undefined, 'limit');
    r.markExhausted('oauth', 'limit', NOW + 3_600_000, undefined, 'limit');
    // The subscription refuses it in its own words and the chat pauses as a limit.
    expect(r.effectiveAccount(accounts)).toBe('oauth');
    expect(r.usableAccounts(accounts)).toEqual([]);
  });

  it('with only capped accounts left, an Automatic turn has nowhere to run', () => {
    const r = new AccountRotation(() => NOW);
    const accounts: FailoverAccount[] = [
      { id: 'bed', connected: true, capped: true },
      { id: 'oauth', connected: false },
    ];
    expect(r.effectiveAccount(accounts)).toBeUndefined();
  });

  it('a locked chat that may continue on another account moves off a capped lock', () => {
    const r = new AccountRotation(() => NOW);
    const accounts: FailoverAccount[] = [
      { id: 'bed', connected: true, auto: false, capped: true },
      { id: 'oauth', connected: true },
    ];
    expect(r.effectiveAccount(accounts, { preferred: 'bed', resumeOnAnyAccount: true })).toBe(
      'oauth',
    );
  });

  it('says it is the monthly cap, names the account, and when it lifts', () => {
    expect(bedrockCapRefusal('Work AWS', NOW)).toBe(
      'Work AWS: Monthly spending cap reached. It is limited until 2026-12-01T00:00:00Z.',
    );
  });
});

describe('a chat locked to an account this host does not hold', () => {
  const accounts: FailoverAccount[] = [{ id: 'sub', connected: true }];

  it('is refused when the account is a Bedrock account on another host', () => {
    const r = new AccountRotation(() => NOW);
    const route = { preferred: 'bedrock-elsewhere', preferredHeldElsewhere: true };
    expect(r.order(accounts, route)).toEqual([]);
    expect(r.effectiveAccount(accounts, route)).toBeUndefined();
    expect(r.usableAccount(accounts, route)).toBeUndefined();
  });

  it('follows the strategy when the account was removed', () => {
    const r = new AccountRotation(() => NOW);
    expect(r.effectiveAccount(accounts, { preferred: 'removed' })).toBe('sub');
  });
});

describe('no account set to switch to automatically', () => {
  it('orders nothing, so the turn is refused rather than run on the store’s default', () => {
    const r = new AccountRotation(() => NOW);
    const accounts: FailoverAccount[] = [
      { id: 'oauth', connected: true, auto: false },
      { id: 'bed', connected: true, auto: false },
    ];
    expect(r.order(accounts)).toEqual([]);
    expect(r.effectiveAccount(accounts)).toBeUndefined();
  });
});

describe('spend the server has not acknowledged', () => {
  const bedrock = { monthlyCapUsd: 100, spentUsd: 95, spentMonth: '2026-11' };
  const spendEvent = (costUsd: number, at = NOW) => ({
    type: 'host.account_spend' as const,
    hostId: 'h1',
    accountId: 'bed',
    costUsd,
    at,
  });

  it('counts against the cap, and survives a restart while offline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-bedrock-pending-'));
    const path = join(dir, 'outbox.jsonl');
    const logger = { warn: () => {}, error: () => {} };
    try {
      const before = new Outbox({ path, logger });
      before.append(spendEvent(3));
      before.append(spendEvent(2.5));
      // Another account's and last month's spend do not count.
      before.append({ ...spendEvent(50), accountId: 'other' });
      before.append(spendEvent(50, Date.UTC(2026, 9, 30)));
      // The host restarts with the link still down: the outbox is read back.
      const after = new Outbox({ path, logger });
      const pending = pendingBedrockSpendUsd(after.pending(), 'bed', NOW);
      expect(pending).toBe(5.5);
      expect(bedrockCappedWith(bedrock, 0, NOW)).toBe(false);
      expect(bedrockCappedWith(bedrock, pending, NOW)).toBe(true);
      // The server acknowledges it (it has added it to the spend it pushes).
      after.ack(after.pending().at(-1)!.position);
      expect(pendingBedrockSpendUsd(after.pending(), 'bed', NOW)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not count a spend the server has already added, and says when an acknowledgement lands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-bedrock-applied-'));
    const logger = { warn: () => {}, error: () => {} };
    let acks = 0;
    try {
      const outbox = new Outbox({
        path: join(dir, 'outbox.jsonl'),
        logger,
        onAck: () => (acks += 1),
      });
      outbox.append({ ...spendEvent(3), spendId: 'a' });
      outbox.append({ ...spendEvent(3), spendId: 'b' });
      // The server committed `a` (95 already includes it) and pushed its
      // snapshot before the acknowledgement arrived: only `b` is still owed.
      const applied = ['a'];
      expect(pendingBedrockSpendUsd(outbox.pending(), 'bed', NOW, applied)).toBe(3);
      expect(bedrockCappedWith({ ...bedrock, spentUsd: 96 }, 3, NOW)).toBe(false);
      outbox.ack(outbox.pending()[0]!.position);
      expect(acks).toBe(1);
      // An acknowledgement that drops nothing new is not news.
      outbox.ack(outbox.pending()[0]!.position - 1);
      expect(acks).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
