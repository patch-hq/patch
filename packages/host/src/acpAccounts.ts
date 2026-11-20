// The ACP accounts this host was last sent (spec/10 § Backend credentials,
// § Account states, § Choosing an account, § Limits).
//
// The server holds each ACP agent's accounts, in order, and sends them with
// every settings snapshot. This picks the account a turn runs on with the same
// account order and strategy Claude and Codex use (`AccountRotation`, one per
// agent), honours a chat locked to one account, and skips an account its agent
// refused: with a limit, or as signed out (a missing sign-in or a key the
// provider rejected). When every account a turn may use is skipped the first is
// used anyway, so the turn fails with that account's own refusal rather than
// running on nothing.
//
// What the agent said about each account is also a fact for the server, which
// derives the account's state from it (decision 24): `report()` is this host's
// `host.account` for the ACP backend. A refusal is reported as such, a sign-in
// refusal as `needsSignIn`, and a turn the agent completed on an account as a
// reading taken then — the only sign of credit ACP gives, which is what lifts a
// limit that stated no reset. Like Claude's, the refusals survive a host
// restart; a new key is a new chance.

import type { AccountStrategy, HostAccountEvent, SharedAcpAccount } from '@patch/wire';
import { AccountRotation, type FailoverAccount, type RouteOptions } from './accountFailover.js';
import type { PersistedAccountExhaustion } from './accountAvailabilityStore.js';

export interface AcpRoute {
  strategy: AccountStrategy;
  /** The account the chat is locked to; it is the only candidate. */
  preferred?: string | undefined;
  /** The limit behaviour is `other_account`: a locked chat runs elsewhere while its account is spent. */
  resumeOnAnyAccount?: boolean;
}

export interface AcpAccountsOptions {
  now?: () => number;
  /** Refusals kept from before a restart. */
  initial?: readonly PersistedAccountExhaustion[];
  /** What is skipped, and what the agent last said, changed: persist and report it. */
  onChange?: (entries: PersistedAccountExhaustion[]) => void;
}

export class AcpAccounts {
  private accounts: SharedAcpAccount[] = [];
  private readonly rotations = new Map<string, AccountRotation>();
  /** Refusals restored from disk whose agent's rotation does not exist yet. */
  private restored: PersistedAccountExhaustion[];
  /** When the agent last completed a turn on each account. */
  private readonly worked = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly o: AcpAccountsOptions = {}) {
    this.now = o.now ?? (() => Date.now());
    this.restored = [...(o.initial ?? [])];
  }

  /**
   * Take the accounts from a snapshot. An account given a new key, or a new
   * account, is a new chance: what was learned about the old key no longer
   * holds. Returns whether anything changed.
   */
  apply(next: readonly SharedAcpAccount[]): boolean {
    const before = new Map(this.accounts.map((a) => [a.id, a.apiKey]));
    const changed = JSON.stringify(next) !== JSON.stringify(this.accounts);
    this.accounts = [...next];
    const ids = new Set(next.map((a) => a.id));
    this.restored = this.restored.filter((e) => ids.has(e.accountId));
    // Refusals restored from disk for an agent already asked about go to its rotation now.
    this.restored = this.restored.filter((e) => {
      const agentId = this.get(e.accountId)?.agentId;
      const r = agentId !== undefined ? this.rotations.get(agentId) : undefined;
      if (!r) return true;
      r.markExhausted(e.accountId, e.reason, e.until, e.at, e.kind ?? 'limit');
      return false;
    });
    for (const a of next) {
      const old = before.get(a.id);
      // An account the host held before with another key: what was learned is about that key.
      if (old !== undefined && old !== a.apiKey) {
        this.rotation(a.agentId).clear(a.id);
        this.worked.delete(a.id);
      }
    }
    if (changed) this.changed();
    return changed;
  }

  /** The agent's accounts in the stored order. */
  forAgent(agentId: string): SharedAcpAccount[] {
    return this.accounts.filter((a) => a.agentId === agentId);
  }

  get(accountId: string): SharedAcpAccount | undefined {
    return this.accounts.find((a) => a.id === accountId);
  }

  /**
   * The account a turn on `agentId` runs on, or undefined when the agent has
   * none. `starting` moves a round-robin on; asking does not.
   */
  resolve(agentId: string, route: AcpRoute, starting = false): SharedAcpAccount | undefined {
    const list = this.failoverList(agentId);
    if (list.length === 0) return undefined;
    const rotation = this.rotation(agentId);
    const id = starting
      ? rotation.startTurn(list, this.routeOf(route))
      : rotation.effectiveAccount(list, this.routeOf(route));
    return id !== undefined ? this.get(id) : undefined;
  }

  /**
   * The agent refused this account with a limit: skip it, and say which
   * account the turn may run on now, if any has not been refused.
   */
  markLimited(accountId: string, reason: string, route: AcpRoute): string | undefined {
    return this.skip(accountId, reason, 'limit', route);
  }

  /** The agent refused this account as signed out, or its key as invalid: skip it until it has a new key. */
  markSignedOut(accountId: string, reason: string): void {
    this.skip(accountId, reason, 'out', { strategy: 'priority' });
  }

  /** The agent completed a turn on this account: it has credit and a working key. */
  noteWorked(accountId: string): void {
    const account = this.get(accountId);
    if (!account) return;
    this.worked.set(accountId, this.now());
    this.rotation(account.agentId).clear(accountId);
    this.changed();
  }

  /** Is this account being skipped? */
  isSkipped(accountId: string): boolean {
    const a = this.get(accountId);
    return a !== undefined && this.rotation(a.agentId).isExhausted(accountId);
  }

  /**
   * This host's `host.account` for the ACP backend: each account and what its
   * agent last said about it. Facts for the server's account states; the host
   * decides no state.
   */
  report(hostId: string, backendId: string): HostAccountEvent {
    const refused = new Map(this.entries().map((e) => [e.accountId, e]));
    return {
      type: 'host.account',
      hostId,
      backendId,
      connected: this.accounts.length > 0,
      accounts: this.accounts.map((a) => {
        const r = refused.get(a.id);
        const worked = this.worked.get(a.id);
        return {
          id: a.id,
          label: a.label,
          connected: true,
          kind: 'apiKey' as const,
          ...(r?.kind === 'out' ? { needsSignIn: true, error: r.reason } : {}),
          ...(r?.kind === 'limit'
            ? { refusal: { kind: 'limit' as const, message: r.reason, at: r.at ?? this.now() } }
            : {}),
          ...(worked !== undefined && r === undefined ? { usage: { at: worked } } : {}),
        };
      }),
    };
  }

  private skip(
    accountId: string,
    reason: string,
    kind: 'limit' | 'out',
    route: AcpRoute,
  ): string | undefined {
    const account = this.get(accountId);
    if (!account) return undefined;
    const rotation = this.rotation(account.agentId);
    rotation.markExhausted(accountId, reason, undefined, this.now(), kind);
    return rotation.usableAccount(this.failoverList(account.agentId), this.routeOf(route));
  }

  /** Every refusal held, restored ones whose agent has not been asked about yet included. */
  private entries(): PersistedAccountExhaustion[] {
    const out: PersistedAccountExhaustion[] = [...this.restored];
    for (const r of this.rotations.values()) {
      for (const e of r.snapshot()) {
        out.push({
          accountId: e.accountId,
          reason: e.reason,
          kind: e.kind,
          at: e.at,
          ...(e.until !== undefined ? { until: e.until } : {}),
        });
      }
    }
    return out;
  }

  private changed(): void {
    this.o.onChange?.(this.entries());
  }

  private failoverList(agentId: string): FailoverAccount[] {
    return this.forAgent(agentId).map((a) => ({ id: a.id, connected: true }));
  }

  private routeOf(route: AcpRoute): RouteOptions {
    return {
      strategy: route.strategy,
      ...(route.preferred !== undefined ? { preferred: route.preferred } : {}),
      ...(route.resumeOnAnyAccount !== undefined
        ? { resumeOnAnyAccount: route.resumeOnAnyAccount }
        : {}),
    };
  }

  private rotation(agentId: string): AccountRotation {
    let r = this.rotations.get(agentId);
    if (!r) {
      const mine = new Set(this.forAgent(agentId).map((a) => a.id));
      const initial = this.restored.filter((e) => mine.has(e.accountId));
      this.restored = this.restored.filter((e) => !mine.has(e.accountId));
      r = new AccountRotation(this.now, initial, () => this.changed());
      this.rotations.set(agentId, r);
    }
    return r;
  }
}
