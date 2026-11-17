// The server's one state per account (spec/10 § Account states).
//
// Hosts report facts: a usage reading, the provider's last refusal, a
// credential the provider turned away. This keeps the freshest of each per
// account, across hosts, and derives the one state from them with the shared
// rule (`deriveAccountState`). Surfaces display what they are sent.
//
// The facts outlive a restart: a server that forgot a limit would hand the next
// turn to an account known to be limited. They are re-derivable (the next host
// report restates them), so the file is written atomically and an unreadable
// one is logged and ignored rather than taking settings down with it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AccountRefusal,
  RateLimitWindow,
  deriveAccountState,
  type AccountState,
  type AccountStateFacts,
  type HostAccountEvent,
} from '@patch/wire';
import { z } from 'zod';

const StoredUsage = z
  .object({
    session: RateLimitWindow.optional(),
    week: RateLimitWindow.optional(),
    overage: RateLimitWindow.optional(),
    at: z.number().optional(),
  })
  .strict();

const StoredFacts = z
  .object({
    usage: StoredUsage.optional(),
    refusal: AccountRefusal.optional(),
  })
  .strict();
type StoredFacts = z.infer<typeof StoredFacts>;

const StoredFile = z.record(z.string(), StoredFacts);

interface HostView {
  /** The provider turned this credential away, as of this host's latest report. */
  credentialRefused: boolean;
  error?: string | undefined;
  reportedAt: number;
}

export interface AccountStateTrackerOptions {
  /** Where the facts are kept; undefined keeps them in memory only (tests). */
  path?: string | undefined;
  now?: () => number;
  logger?: { warn: (obj: object, msg: string) => void } | undefined;
  /** What `stateFor` reads has changed; the caller compares states and tells surfaces. */
  onChange: () => void;
}

export class AccountStateTracker {
  private readonly stored = new Map<string, StoredFacts>();
  /** accountId → hostId → what that host last said about the credential. */
  private readonly views = new Map<string, Map<string, HostView>>();
  /** When each account's credential last changed, so an older refusal does not outlive it. */
  private readonly credentialChangedAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly opts: AccountStateTrackerOptions) {
    this.now = opts.now ?? Date.now;
    this.load();
  }

  private load(): void {
    const { path } = this.opts;
    if (!path || !existsSync(path)) return;
    try {
      const parsed = StoredFile.parse(JSON.parse(readFileSync(path, 'utf8')));
      for (const [id, facts] of Object.entries(parsed)) this.stored.set(id, facts);
    } catch (err) {
      // Re-derivable: the next report restates it. Loud, but not fatal.
      this.opts.logger?.warn(
        { path, err: (err as Error).message },
        'account states: ignoring unreadable file',
      );
    }
  }

  private save(): void {
    const { path } = this.opts;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(this.stored), null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(tmp, path);
    } catch (err) {
      this.opts.logger?.warn(
        { path, err: (err as Error).message },
        'account states: could not write the file',
      );
    }
  }

  /** A host's account report: fold in the freshest usage and refusal, and what it says of the credential. */
  observe(report: HostAccountEvent): void {
    let factsChanged = false;
    for (const summary of report.accounts ?? []) {
      const facts = this.stored.get(summary.id) ?? {};
      const next: StoredFacts = { ...facts };
      if (summary.usage && (summary.usage.at ?? 0) >= (facts.usage?.at ?? 0)) {
        next.usage = summary.usage;
      }
      if (summary.refusal && summary.refusal.at >= (facts.refusal?.at ?? 0)) {
        next.refusal = summary.refusal;
      }
      if (JSON.stringify(next) !== JSON.stringify(facts)) {
        this.stored.set(summary.id, next);
        factsChanged = true;
      }
      let perHost = this.views.get(summary.id);
      if (!perHost) this.views.set(summary.id, (perHost = new Map()));
      perHost.set(report.hostId, {
        credentialRefused: summary.needsSignIn === true,
        error: summary.error,
        reportedAt: this.now(),
      });
    }
    if (factsChanged) this.save();
    this.opts.onChange();
  }

  /** The credential was replaced, signed in again or removed: what was said about the old one no longer holds. */
  credentialReplaced(accountId: string): void {
    this.credentialChangedAt.set(accountId, this.now());
    this.views.delete(accountId);
    const facts = this.stored.get(accountId);
    if (facts?.refusal) {
      // A new credential is a new chance: signing in again, or adding credit,
      // makes waiting work runnable at once. A pool that is still limited is
      // restated by the next reading.
      delete facts.refusal;
      this.save();
    }
    this.opts.onChange();
  }

  forget(accountId: string): void {
    this.stored.delete(accountId);
    this.views.delete(accountId);
    this.credentialChangedAt.delete(accountId);
    this.save();
  }

  /** The state of one account now. */
  stateFor(
    accountId: string,
    own: { hasCredential: boolean; renewalError?: string | undefined; apiKey?: boolean },
  ): AccountState {
    const facts = this.stored.get(accountId);
    const changedAt = this.credentialChangedAt.get(accountId) ?? 0;
    let credentialRefused = false;
    let error: string | undefined;
    for (const view of this.views.get(accountId)?.values() ?? []) {
      if (view.reportedAt < changedAt) continue;
      credentialRefused ||= view.credentialRefused;
      error ??= view.error;
    }
    const input: AccountStateFacts = {
      hasCredential: own.hasCredential,
      renewalError: own.renewalError,
      credentialRefused,
      error,
      refusal: facts?.refusal,
      // An API key has no subscription windows; a reading of one is not about it.
      usage: own.apiKey ? undefined : facts?.usage,
    };
    return deriveAccountState(input, this.now());
  }
}
