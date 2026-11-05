// The host half of `patch.events.*`: the machine's own CLI tails the account's
// event stream through this host's link, so `patch logs` needs no credential of
// its own. One subscription per CLI stream; the server sends matching events
// back as `patch.events.event` until it is unsubscribed or the link drops.

import { randomUUID } from 'node:crypto';
import type { WireEvent } from '@patch/wire';
import { AccountsRpcError } from './accountsClient.js';

export interface ServerEventsHandlers {
  onEvent: (event: Record<string, unknown>) => void;
  /** The stream ended without the caller asking (link dropped). */
  onEnd: (reason: string) => void;
}

export class ServerEventsClient {
  private readonly subs = new Map<string, ServerEventsHandlers>();
  constructor(
    private readonly o: {
      emit: (event: WireEvent) => void;
      isLinkOnline: () => boolean;
      idGen?: () => string;
    },
  ) {}

  /** Start a stream. Returns the stop function. Throws if the link is offline. */
  subscribe(handlers: ServerEventsHandlers): () => void {
    if (!this.o.isLinkOnline()) {
      throw new AccountsRpcError('link_offline', 'server events: host→server link is offline');
    }
    const subscriptionId = (this.o.idGen ?? randomUUID)();
    this.subs.set(subscriptionId, handlers);
    this.o.emit({ type: 'patch.events.subscribe', subscriptionId } as WireEvent);
    return () => {
      if (!this.subs.delete(subscriptionId)) return;
      if (this.o.isLinkOnline()) {
        this.o.emit({ type: 'patch.events.unsubscribe', subscriptionId } as WireEvent);
      }
    };
  }

  handleEvent(event: WireEvent): boolean {
    if (event.type !== 'patch.events.event') return false;
    const sub = this.subs.get(event.subscriptionId);
    if (!sub) return false;
    sub.onEvent(event.event);
    return true;
  }

  /** The link dropped: the server forgets this machine's subscriptions, so end them all. */
  endAll(reason: string): void {
    const all = [...this.subs.values()];
    this.subs.clear();
    for (const s of all) s.onEnd(reason);
  }
}
