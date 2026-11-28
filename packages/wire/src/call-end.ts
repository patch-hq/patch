// Ending a call is a change to the call's state that goes through the server
// like every other user action (spec/07 § Ending a call), not a frame on the
// audio socket, which may be down. The request is held until the server says
// it has recorded the end (`voice.call_ended`), and sent again on a fixed
// interval and whenever the link is back; the request id is the session's, so
// a redelivery is the same request.

import type { VoiceEndCallRequestEvent } from './events.js';

/** How often an unanswered end is sent again. */
export const CALL_END_RETRY_MS = 5_000;

export interface CallEndOutboxOptions {
  /** Send on the surface's server channel; throws when it is not open. */
  send: (event: VoiceEndCallRequestEvent) => void;
  retryMs?: number;
}

interface Pending {
  event: VoiceEndCallRequestEvent;
  timer: ReturnType<typeof setTimeout> | null;
}

export class CallEndOutbox {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: CallEndOutboxOptions) {}

  /** End the call: send now and hold until the server answers. */
  end(chatId: string, sessionId: string): void {
    const requestId = `end-${sessionId}`;
    if (this.pending.has(requestId)) return;
    const entry: Pending = {
      event: { type: 'voice.end_call_request', chatId, sessionId, requestId },
      timer: null,
    };
    this.pending.set(requestId, entry);
    this.deliver(entry);
  }

  /** The server recorded the end. */
  answered(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.pending.delete(requestId);
  }

  /** The link is back: send every end still unanswered. */
  onReconnect(): void {
    for (const entry of this.pending.values()) this.deliver(entry);
  }

  size(): number {
    return this.pending.size;
  }

  reset(): void {
    for (const entry of this.pending.values()) if (entry.timer !== null) clearTimeout(entry.timer);
    this.pending.clear();
  }

  private deliver(entry: Pending): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    try {
      this.opts.send(entry.event);
    } catch {
      // The channel is down: the end stays held, and the timer or the reconnect sends it.
    }
    entry.timer = setTimeout(() => {
      if (this.pending.get(entry.event.requestId) === entry) this.deliver(entry);
    }, this.opts.retryMs ?? CALL_END_RETRY_MS);
  }
}
