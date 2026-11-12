// Dead-peer detection for an audio WebSocket. A device that resets or loses
// Wi-Fi never sends a close frame, so the socket (and the session on it) would
// stay open forever. Anything heard from the peer — a frame or a pong — counts
// as alive; a peer silent for `timeoutMs` has its socket terminated, which runs
// the normal close path. A ping goes out every `pingIntervalMs` so a peer that
// is connected but legitimately quiet still answers.

import type WebSocket from 'ws';

/** No frame or pong for this long ends the session. */
export const DEAD_PEER_TIMEOUT_MS = 45_000;
/** How often the peer is pinged (and the silence checked). */
export const PING_INTERVAL_MS = 15_000;

export interface LivenessOptions {
  timeoutMs?: number;
  pingIntervalMs?: number;
  /** Called just before the socket is terminated. */
  onDead?: (silentMs: number) => void;
}

/** Start watching `ws`; stops itself when the socket closes. */
export function watchPeerLiveness(ws: WebSocket, opts: LivenessOptions = {}): void {
  const timeoutMs = opts.timeoutMs ?? DEAD_PEER_TIMEOUT_MS;
  const pingMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
  let lastHeard = Date.now();
  const heard = (): void => {
    lastHeard = Date.now();
  };
  ws.on('message', heard);
  ws.on('pong', heard);
  const timer = setInterval(() => {
    const silent = Date.now() - lastHeard;
    if (silent >= timeoutMs) {
      opts.onDead?.(silent);
      ws.terminate();
      return;
    }
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }, pingMs);
  timer.unref();
  ws.once('close', () => clearInterval(timer));
}
