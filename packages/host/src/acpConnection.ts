// The client end of an Agent Client Protocol connection (spec/02 § Provider
// adapters).
//
// ACP is JSON-RPC 2.0, one message per line, on the agent's stdio. The
// official library (`@agentclientprotocol/sdk`) supplies the protocol's types
// and method names; the connection itself is this small peer rather than the
// library's, because a turn that survives a host restart is carried on by a
// NEW host over a runner that kept the agent's stdio (`acpBackend.ts`,
// `codexDurable.ts`). That host must answer requests the agent made of the
// previous one, await the response to a prompt the previous one sent, and
// number its own requests past the previous host's: none of which a
// connection that starts at `initialize` can do.
//
// The peer is transport-free: lines go out through `send`, and whoever owns
// the process feeds lines in through `receive`.

import type { AnyMessage } from '@agentclientprotocol/sdk';

/** JSON-RPC's own error codes, and ACP's `auth_required`. */
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;
export const ACP_AUTH_REQUIRED = -32000;

/** An error the agent answered a request with, in its own words. */
export class AcpRpcError extends Error {
  override readonly name = 'AcpRpcError';
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** The agent went away with the request unanswered. */
export class AcpClosedError extends Error {
  override readonly name = 'AcpClosedError';
}

type Id = number | string;

export interface AcpConnectionHandlers {
  /** A notification from the agent (`session/update`). */
  onNotification(method: string, params: unknown): void;
  /**
   * A request from the agent (`session/request_permission`). Resolve with the
   * result; throw an `AcpRpcError` to answer with that error.
   */
  onRequest(method: string, params: unknown, id: Id): Promise<unknown>;
  /** A line that is not JSON-RPC, or a response to nothing this peer asked. */
  onStray?(line: string): void;
}

export class AcpConnection {
  private nextId: number;
  private readonly pending = new Map<
    Id,
    { method: string; resolve(v: unknown): void; reject(e: Error): void }
  >();
  private closedReason: string | undefined;

  constructor(
    private readonly send: (line: string) => void,
    private readonly handlers: AcpConnectionHandlers,
    opts: { firstId?: number } = {},
  ) {
    this.nextId = opts.firstId ?? 0;
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /** Ask the agent something and wait for its answer. */
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closedReason !== undefined)
      return Promise.reject(new AcpClosedError(this.closedReason));
    const id = this.nextId++;
    const answer = this.await<T>(id, method);
    this.write({ jsonrpc: '2.0', id, method, params } as AnyMessage);
    return answer;
  }

  /**
   * Wait for the answer to a request sent before this peer existed — the prompt
   * a previous host sent on a turn this one carries on.
   */
  await<T = unknown>(id: Id, method: string): Promise<T> {
    if (this.closedReason !== undefined)
      return Promise.reject(new AcpClosedError(this.closedReason));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
    });
  }

  /** The id the next request goes out under. */
  peekNextId(): number {
    return this.nextId;
  }

  notify(method: string, params: unknown): void {
    if (this.closedReason !== undefined) return;
    this.write({ jsonrpc: '2.0', method, params } as AnyMessage);
  }

  /** One line the agent wrote. */
  receive(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      msg = parsed as Record<string, unknown>;
    } catch {
      this.handlers.onStray?.(line);
      return;
    }
    const method = msg['method'];
    const id = msg['id'] as Id | undefined;
    if (typeof method === 'string') {
      if (id === undefined || id === null) {
        this.handlers.onNotification(method, msg['params']);
        return;
      }
      void this.answer(id, method, msg['params']);
      return;
    }
    if (id === undefined || id === null) {
      this.handlers.onStray?.(line);
      return;
    }
    const waiting = this.pending.get(id);
    if (!waiting) {
      this.handlers.onStray?.(line);
      return;
    }
    this.pending.delete(id);
    const error = msg['error'] as { code?: unknown; message?: unknown; data?: unknown } | undefined;
    if (error) {
      waiting.reject(
        new AcpRpcError(
          waiting.method,
          typeof error.code === 'number' ? error.code : RPC_INTERNAL_ERROR,
          typeof error.message === 'string' && error.message
            ? error.message
            : `${waiting.method} failed`,
          error.data,
        ),
      );
      return;
    }
    waiting.resolve(msg['result']);
  }

  /** The agent is gone: everything still waiting fails with `reason`. */
  close(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const [, waiting] of this.pending) waiting.reject(new AcpClosedError(reason));
    this.pending.clear();
  }

  private async answer(id: Id, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params, id);
      this.write({ jsonrpc: '2.0', id, result: result ?? null } as AnyMessage);
    } catch (err) {
      const code = err instanceof AcpRpcError ? err.code : RPC_INTERNAL_ERROR;
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code, message: (err as Error).message },
      } as AnyMessage);
    }
  }

  private write(msg: AnyMessage): void {
    if (this.closedReason !== undefined) return;
    this.send(JSON.stringify(msg));
  }
}
