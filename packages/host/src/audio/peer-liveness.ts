// A gone peer on an audio WebSocket (spec/07 § A dropped call comes back). A
// phone that loses its network or is killed never sends a close frame, so the
// socket (and the session on it) would stay open. The host judges the peer by
// what it hears from it, on the same rule a surface judges the host: nothing
// for `HEARTBEAT_LOST_AFTER_MS` and the peer is gone, and its socket is
// terminated, which runs the normal close path.
//
// Only frames count. A WebSocket ping is answered by whatever holds the other
// end of this socket, and that is usually the server's relay (or this host's
// own tunnel bridge), not the device, so a pong says nothing about the device.
// A live app surface always has something to send: it answers the heartbeat the
// host sends on every app session (call-heartbeat.ts), microphone or not. A
// voice device's firmware does not, so its sessions are not watched here
// (`stop`): the device is judged by its own link.

import type WebSocket from 'ws';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_LOST_AFTER_MS } from '@patch/wire/audio';

export interface LivenessOptions {
  /** Called just before the socket is terminated. */
  onGone?: (silentMs: number) => void;
  now?: () => number;
}

/** Start watching `ws`; stops itself when the socket closes, or on `stop`. */
export function watchPeerLiveness(ws: WebSocket, opts: LivenessOptions = {}): { stop(): void } {
  const now = opts.now ?? Date.now;
  let lastHeard = now();
  ws.on('message', () => {
    lastHeard = now();
  });
  const timer = setInterval(() => {
    const silent = now() - lastHeard;
    if (silent < HEARTBEAT_LOST_AFTER_MS) return;
    clearInterval(timer);
    opts.onGone?.(silent);
    ws.terminate();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  ws.once('close', () => clearInterval(timer));
  return { stop: () => clearInterval(timer) };
}
