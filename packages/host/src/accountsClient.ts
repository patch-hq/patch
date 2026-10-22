// The host half of the shared-accounts RPC: ask the server for the shared
// accounts (their order and strategy), or change them, over the link the host
// already holds. Same shape as `PadClient`. NO FALLBACK: an offline link, a
// timeout or a server refusal all raise with the server's own reason.

import { randomUUID } from 'node:crypto';
import type { WireEvent } from '@patch/wire';
import { PatchAccountsResponseEvent } from '@patch/wire';

export type AccountsRequest =
  | { op: 'list' }
  | { op: 'order'; backendId: 'claude-code' | 'codex'; accountIds: string[] }
  | {
      op: 'strategy';
      backendId: 'claude-code' | 'codex';
      strategy: 'priority' | 'round-robin' | 'soonest-reset' | 'least-used';
    };

export type AccountsRpc = (req: AccountsRequest) => Promise<unknown>;

/** The server refused: carries its code (`invalid_order`, `unknown_backend`, ...). */
export class AccountsRpcError extends Error {
  override readonly name = 'AccountsRpcError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AccountsClientOptions {
  emit: (event: WireEvent) => void;
  isLinkOnline: () => boolean;
  requestTimeoutMs?: number;
  idGen?: () => string;
}

export class AccountsClient {
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly emit: (event: WireEvent) => void;
  private readonly isLinkOnline: () => boolean;
  private readonly timeoutMs: number;
  private readonly idGen: () => string;

  constructor(opts: AccountsClientOptions) {
    this.emit = opts.emit;
    this.isLinkOnline = opts.isLinkOnline;
    this.timeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.idGen = opts.idGen ?? ((): string => randomUUID());
  }

  /** Feed a `patch.accounts.response` in. True when it matched a waiting request. */
  handleResponse(event: WireEvent): boolean {
    if (event.type !== 'patch.accounts.response') return false;
    const parsed = PatchAccountsResponseEvent.safeParse(event);
    if (!parsed.success) return false;
    const waiter = this.pending.get(parsed.data.requestId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.pending.delete(parsed.data.requestId);
    if (parsed.data.ok) waiter.resolve(parsed.data.result);
    else
      waiter.reject(
        new AccountsRpcError(
          parsed.data.error?.code ?? 'internal',
          parsed.data.error?.message ?? 'the accounts request failed on the server',
        ),
      );
    return true;
  }

  request: AccountsRpc = (input) => {
    if (!this.isLinkOnline()) {
      return Promise.reject(
        new AccountsRpcError('link_offline', 'accounts: host→server link is offline'),
      );
    }
    const requestId = this.idGen();
    return new Promise<unknown>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new AccountsRpcError(
            'timeout',
            `accounts: the server did not answer within ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve: resolvePromise, reject, timer });
      this.emit({ type: 'patch.accounts.request', requestId, ...input } as WireEvent);
    });
  };
}

/**
 * Resolve what a caller typed — an account id, or its label (case-insensitive)
 * — to exactly one stored account. Ambiguous or unknown refs raise, naming the
 * candidates: running a chat on the wrong account is the failure this prevents.
 */
export function resolveAccountRef(
  ref: string,
  held: ReadonlyArray<{ id: string; label: string }>,
): string {
  const byId = held.find((a) => a.id === ref);
  if (byId) return byId.id;
  const wanted = ref.trim().toLowerCase();
  const byLabel = held.filter((a) => a.label.trim().toLowerCase() === wanted);
  if (byLabel.length === 1) return byLabel[0]!.id;
  const names = held.map((a) => `${a.label} (${a.id})`).join(', ') || 'none';
  throw new AccountRefError(
    byLabel.length > 1
      ? `account "${ref}" matches more than one account (${byLabel.map((a) => a.id).join(', ')}); use the id`
      : `no account "${ref}" on this machine (holds: ${names})`,
  );
}

export class AccountRefError extends Error {
  override readonly name = 'AccountRefError';
}

export interface ServerApiCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}
export interface ServerApiAnswer {
  status: number;
  body?: unknown;
}
export type ServerApiRpc = (call: ServerApiCall) => Promise<ServerApiAnswer>;

/** The host half of `patch.api.request`: one REST call to the server, over the link. */
export class ServerApiClient {
  private readonly pending = new Map<
    string,
    { resolve: (v: ServerApiAnswer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(
    private readonly o: {
      emit: (event: WireEvent) => void;
      isLinkOnline: () => boolean;
      requestTimeoutMs?: number;
      idGen?: () => string;
    },
  ) {}

  handleResponse(event: WireEvent): boolean {
    if (event.type !== 'patch.api.response') return false;
    const waiter = this.pending.get(event.requestId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.pending.delete(event.requestId);
    waiter.resolve({
      status: event.status,
      ...(event.body !== undefined ? { body: event.body } : {}),
    });
    return true;
  }

  request: ServerApiRpc = (call) => {
    if (!this.o.isLinkOnline()) {
      return Promise.reject(
        new AccountsRpcError('link_offline', 'server api: host→server link is offline'),
      );
    }
    const requestId = (this.o.idGen ?? randomUUID)();
    const timeoutMs = this.o.requestTimeoutMs ?? 30_000;
    return new Promise<ServerApiAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AccountsRpcError('timeout', `server api: no answer within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      this.o.emit({ type: 'patch.api.request', requestId, ...call } as WireEvent);
    });
  };
}
