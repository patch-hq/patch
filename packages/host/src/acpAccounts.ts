// The ACP accounts this host was last sent (spec/10 § Backend credentials,
// § Choosing an account, § Limits).
//
// The server holds each ACP agent's accounts, in order, and sends them with
// every settings snapshot. This picks the account a turn runs on with the same
// account order and strategy Claude and Codex use (`AccountRotation`, one per
// agent), and skips an account the agent refused as limited or signed out. When
// every account of an agent is skipped the first is used anyway, so the turn
// fails with that account's own refusal rather than running on nothing; ACP
// limits state no reset, so a skipped account stays skipped until it is given a
// new key, or until no other is left.

import type { AccountStrategy, SharedAcpAccount } from '@patch/wire';
import { AccountRotation, type FailoverAccount, type RouteOptions } from './accountFailover.js';

export interface AcpRoute {
  strategy: AccountStrategy;
}

export class AcpAccounts {
  private accounts: SharedAcpAccount[] = [];
  private readonly rotations = new Map<string, AccountRotation>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Take the accounts from a snapshot. An account given a new key, or a new
   * account, is a new chance: what was learned about the old key no longer
   * holds. Returns whether anything changed.
   */
  apply(next: readonly SharedAcpAccount[]): boolean {
    const before = new Map(this.accounts.map((a) => [a.id, a.apiKey]));
    const changed = JSON.stringify(next) !== JSON.stringify(this.accounts);
    this.accounts = [...next];
    for (const a of next) {
      if (before.get(a.id) !== a.apiKey) this.rotation(a.agentId).clear(a.id);
    }
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
   * account of the same agent the turn can run on now, if any has not been
   * refused.
   */
  markLimited(accountId: string, reason: string, route: AcpRoute): string | undefined {
    return this.skip(accountId, reason, 'limit', route);
  }

  /** The agent refused this account as signed out: skip it until it is given a new key. */
  markSignedOut(accountId: string): void {
    this.skip(accountId, 'the agent refused this key as signed out', 'out', {
      strategy: 'priority',
    });
  }

  /** Is this account being skipped? */
  isSkipped(accountId: string): boolean {
    const a = this.get(accountId);
    return a !== undefined && this.rotation(a.agentId).isExhausted(accountId);
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

  private failoverList(agentId: string): FailoverAccount[] {
    return this.forAgent(agentId).map((a) => ({ id: a.id, connected: true }));
  }

  private routeOf(route: AcpRoute): RouteOptions {
    return { strategy: route.strategy };
  }

  private rotation(agentId: string): AccountRotation {
    let r = this.rotations.get(agentId);
    if (!r) this.rotations.set(agentId, (r = new AccountRotation(this.now)));
    return r;
  }
}
