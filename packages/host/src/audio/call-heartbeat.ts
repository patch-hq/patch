// The heartbeat an app session's line is judged by, both ways (spec/07 § A
// dropped call comes back). While any app session is open — a call, dictation,
// a spoken alert — the host sends `audio.heartbeat` every second; on a call the
// surface that hears nothing for three seconds shows and sounds lost contact
// (it does not end the line). The surface echoes each one, which is how the host
// measures the round trip — it sends the latest back on the next heartbeat, so the surface can log it, and
// keeps its own count for the session's closing log.

import { HEARTBEAT_INTERVAL_MS, type AudioHeartbeatEvent } from '@patch/wire/audio';

/** How many unanswered heartbeats are remembered for a late echo. */
const PENDING_ECHOES = 30;

export interface CallHeartbeatStats {
  sent: number;
  echoed: number;
  rttMs?: { min: number; avg: number; max: number };
}

export interface CallHeartbeat {
  /** The surface echoed heartbeat `n`. */
  echoed(n: number): void;
  stats(): CallHeartbeatStats;
  stop(): void;
}

export function startCallHeartbeat(
  sessionId: string,
  send: (frame: AudioHeartbeatEvent) => void,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
  now: () => number = Date.now,
): CallHeartbeat {
  let seq = 0;
  let echoed = 0;
  let lastRtt: number | undefined;
  let rttMin = Infinity;
  let rttMax = 0;
  let rttSum = 0;
  const sentAt = new Map<number, number>();
  const beat = (): void => {
    sentAt.set(seq, now());
    if (sentAt.size > PENDING_ECHOES) sentAt.delete(seq - PENDING_ECHOES);
    send({
      type: 'audio.heartbeat',
      sessionId,
      n: seq,
      ...(lastRtt !== undefined ? { rttMs: lastRtt } : {}),
    });
    seq += 1;
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return {
    echoed(n) {
      const at = sentAt.get(n);
      if (at === undefined) return;
      sentAt.delete(n);
      const rtt = now() - at;
      echoed += 1;
      lastRtt = rtt;
      rttMin = Math.min(rttMin, rtt);
      rttMax = Math.max(rttMax, rtt);
      rttSum += rtt;
    },
    stats() {
      return {
        sent: seq,
        echoed,
        ...(echoed > 0
          ? { rttMs: { min: rttMin, avg: Math.round(rttSum / echoed), max: rttMax } }
          : {}),
      };
    },
    stop() {
      clearInterval(timer);
    },
  };
}
