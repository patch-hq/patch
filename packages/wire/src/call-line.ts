// The line under a call, the same on every surface (spec/07 § A dropped call
// comes back, § Call logs).
//
// A call is one line made of a run of attempts: the first dial, then an attempt
// to resume the same session each time the line drops. This module decides everything about that line
// that does not depend on how a surface opens a socket or plays audio:
//
// - when an attempt is live (the host acknowledged it), and when it is lost: a
//   closed connection, the host gone, or no answer in time. Silence on a line
//   that is still open never loses it: after three seconds without a heartbeat
//   the surface is told contact is lost (what the user sees and hears), and
//   told again when the host is heard from;
// - trying to resume a lost line, on one backoff, naming the session it was last
//   live on so the host puts the attempt back on it, until the host's resume
//   window runs out; then the call is over. A line never opens a new session
//   by itself after a drop;
// - the call log: why audio stopped, the heartbeat's measure of the
//   connection, how long each step of each turn took, sent to the host when
//   the line is back and when the call ends.
//
// A surface drives it with what it hears (acked, heartbeat, lost, fail, turn
// marks) and does what it is told (dial, hang up an attempt, send a frame,
// show a phase). Each attempt carries its own number, so a late event from an
// attempt that has already been replaced or written off changes nothing.

import {
  CALL_LOG_MAX_ENTRIES,
  CALL_RESUME_WINDOW_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_LOST_AFTER_MS,
  type AudioCallLogEvent,
  type AudioHeartbeatEvent,
  type CallLogEntry,
  type CallStopReason,
} from './audio.js';

/**
 * Delays between attempts to resume a dropped line; the last repeats until the
 * host's resume window (`CALL_RESUME_WINDOW_MS`) runs out and the call ends.
 */
export const CALL_RESUME_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 15_000, 20_000, 30_000,
];

/**
 * An attempt the host has not acknowledged in this long has failed: long
 * enough for the host to open a provider's session over a slow network.
 */
export const CALL_ACK_TIMEOUT_MS = 15_000;

/** A heartbeat this much later than the interval counts as late. */
const LATE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 1.5;

/** `reconnecting` is the line lost and being resumed; `ended` is the resume window run out. */
export type CallLinePhase = 'connecting' | 'live' | 'reconnecting' | 'failed' | 'ended';

/** Where a turn's timing has got to; see `CallLine.turn`. */
export type TurnMark = 'speech_end' | 'transcript' | 'reply_audio' | 'reply_end';

export interface CallLineClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What the line asks of the surface it runs on. */
export interface CallLineSurface {
  /**
   * Open a session for this attempt. `resumes` names the session the call was
   * last live on, on a resume attempt: the host puts the attempt back on it.
   */
  dial(attempt: number, resumes: string | null): void;
  /** Close this attempt's session: the line has written it off. The call goes on. */
  hangUp(attempt: number): void;
  /** Send a frame on this attempt's session; false when it has none open. */
  send(attempt: number, frame: AudioHeartbeatEvent | AudioCallLogEvent): boolean;
  /** The line moved to `next`; `reason` says why when it failed. */
  phase(next: CallLinePhase, prev: CallLinePhase, reason?: string): void;
  /**
   * Whether the host is being heard on the live line. Silence is only shown
   * and sounded (spec/07 § A dropped call comes back); it never ends the line.
   */
  contact(heard: boolean): void;
}

interface Quality {
  heartbeats: number;
  lost: number;
  late: number;
  maxGapMs: number;
  lastN: number;
  lastHeardAt: number;
  rttMin: number;
  rttMax: number;
  rttSum: number;
  rttCount: number;
}

interface Attempt {
  n: number;
  sessionId: string | null;
  /** Written off (lost, failed or the call ended); nothing more it says counts. */
  over: boolean;
  quality: Quality;
  /** The last time the host was heard from: its acknowledgement or a heartbeat. */
  lastHeardAt: number;
}

interface Turn {
  speechEndAt?: number;
  transcriptAt?: number;
  replyAudioAt?: number;
}

const realClock: CallLineClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class CallLine {
  private state: CallLinePhase = 'connecting';
  private cur: Attempt = CallLine.attempt(0, 0);
  private ended = false;
  private redials = 0;
  private startRetried = false;
  private downSince = 0;
  private lastLiveSessionId: string | null = null;
  private ackTimer: unknown = null;
  private redialTimer: unknown = null;
  private windowTimer: unknown = null;
  private silenceTimer: unknown = null;
  private silent = false;
  private turnAt: Turn | null = null;
  private log: CallLogEntry[] = [];
  private droppedEntries = 0;

  constructor(
    private readonly surface: CallLineSurface,
    private readonly clock: CallLineClock = realClock,
  ) {}

  private static attempt(n: number, now: number): Attempt {
    return {
      n,
      sessionId: null,
      over: n === 0,
      lastHeardAt: now,
      quality: {
        heartbeats: 0,
        lost: 0,
        late: 0,
        maxGapMs: 0,
        lastN: -1,
        lastHeardAt: now,
        rttMin: Infinity,
        rttMax: 0,
        rttSum: 0,
        rttCount: 0,
      },
    };
  }

  get phase(): CallLinePhase {
    return this.state;
  }

  /** The session the call was last live on; null before the first ack. */
  get sessionId(): string | null {
    return this.lastLiveSessionId;
  }

  /** The attempt now being dialled or live. */
  get attempt(): number {
    return this.cur.n;
  }

  /** Whether `attempt` is the current one and still counts. */
  isCurrent(attempt: number): boolean {
    return !this.ended && attempt === this.cur.n && !this.cur.over;
  }

  /** Place the call. */
  start(): void {
    this.dial(null);
  }

  /** The host acknowledged the attempt (its first turn state): the line is live. */
  acked(attempt: number, sessionId: string): void {
    if (!this.isCurrent(attempt)) return;
    if (this.state === 'live') return;
    this.clear('ackTimer');
    this.clear('windowTimer');
    this.cur.sessionId = sessionId;
    this.lastLiveSessionId = sessionId;
    const prev = this.state;
    if (prev === 'reconnecting') {
      this.record({
        kind: 'reconnected',
        at: this.clock.now(),
        sessionId,
        downMs: Math.max(0, this.clock.now() - this.downSince),
        attempts: this.redials,
      });
    }
    this.redials = 0;
    this.cur.lastHeardAt = this.clock.now();
    if (this.cur.quality.heartbeats === 0) this.cur.quality.lastHeardAt = this.clock.now();
    this.move('live');
    this.hear();
    this.flushLog();
  }

  /** A heartbeat from the host on `attempt`'s session. */
  heartbeat(attempt: number, frame: AudioHeartbeatEvent): void {
    if (!this.isCurrent(attempt)) return;
    const now = this.clock.now();
    const q = this.cur.quality;
    if (q.heartbeats > 0) {
      const gap = now - q.lastHeardAt;
      if (gap > LATE_AFTER_MS) q.late += 1;
      q.maxGapMs = Math.max(q.maxGapMs, gap);
    }
    if (frame.n > q.lastN + 1) q.lost += frame.n - q.lastN - 1;
    q.heartbeats += 1;
    q.lastN = Math.max(q.lastN, frame.n);
    q.lastHeardAt = now;
    if (frame.rttMs !== undefined) {
      q.rttMin = Math.min(q.rttMin, frame.rttMs);
      q.rttMax = Math.max(q.rttMax, frame.rttMs);
      q.rttSum += frame.rttMs;
      q.rttCount += 1;
    }
    this.cur.lastHeardAt = now;
    // Before the acknowledgement the ack timeout is what judges the attempt.
    if (this.state === 'live') this.hear();
  }

  /**
   * The host was heard: contact is back if it was lost, and three seconds from
   * now with nothing more heard it is lost. Indication only; the line stays up.
   */
  private hear(): void {
    this.clear('silenceTimer');
    this.setContact(true);
    this.silenceTimer = this.clock.setTimeout(() => {
      this.silenceTimer = null;
      this.setContact(false);
    }, HEARTBEAT_LOST_AFTER_MS);
  }

  private setContact(heard: boolean): void {
    if (this.silent === !heard) return;
    this.silent = !heard;
    this.surface.contact(heard);
  }

  /**
   * `attempt` is gone: its connection closed, the host went away, it timed out
   * or its setup failed. A live line starts trying to resume; a failed resume
   * tries again until the window runs out; a first dial that never connected
   * has failed.
   */
  lost(attempt: number, reason: CallStopReason, detail: string): void {
    if (!this.isCurrent(attempt)) return;
    this.cur.over = true;
    this.clear('ackTimer');
    this.clear('silenceTimer');
    this.silent = false;
    if (this.state === 'connecting') {
      this.move('failed', detail);
      return;
    }
    if (this.state === 'live') {
      const sessionId = this.cur.sessionId as string;
      this.closeTurn();
      this.record({ kind: 'audio_stopped', at: this.clock.now(), sessionId, reason, detail });
      this.recordQuality();
      this.downSince = this.clock.now();
      // The host holds the session this long; after it there is nothing to resume.
      this.windowTimer = this.clock.setTimeout(() => {
        this.windowTimer = null;
        this.giveUp();
      }, CALL_RESUME_WINDOW_MS);
      this.move('reconnecting');
    }
    this.scheduleRedial();
  }

  /**
   * The host reported an error it ends the call on: the call has failed,
   * whatever the line was doing, and the close that follows is not a drop.
   */
  fail(attempt: number, message: string): void {
    if (!this.isCurrent(attempt)) return;
    this.cur.over = true;
    this.stopTimers();
    // The voice agent stalling before the call connected is usually transient:
    // dial once more, then say so. The retry is not hidden — a second failure fails.
    if (
      this.state === 'connecting' &&
      !this.startRetried &&
      message.startsWith('elevenlabs_unavailable')
    ) {
      this.startRetried = true;
      this.surface.hangUp(attempt);
      this.dial(null);
      return;
    }
    this.move('failed', message);
  }

  /** Audio stopped on the device while the line stayed up (focus taken, device change). */
  audioStopped(reason: CallStopReason, detail: string): void {
    if (this.ended || this.state !== 'live') return;
    this.record({
      kind: 'audio_stopped',
      at: this.clock.now(),
      sessionId: this.cur.sessionId as string,
      reason,
      detail,
    });
  }

  /**
   * A step of a turn was reached. The turn's timings are logged when the reply
   * ends, or when the next one starts: speech end → transcript (speech to
   * text), transcript → first reply audio (the model), first reply audio →
   * reply end (the voice).
   */
  turn(mark: TurnMark): void {
    if (this.ended || this.state !== 'live') return;
    const now = this.clock.now();
    if (mark === 'speech_end') {
      this.closeTurn();
      this.turnAt = { speechEndAt: now };
      return;
    }
    if (mark === 'transcript') {
      if (this.turnAt === null) this.turnAt = {};
      this.turnAt.transcriptAt ??= now;
      return;
    }
    if (this.turnAt === null) return;
    if (mark === 'reply_audio') {
      this.turnAt.replyAudioAt ??= now;
      return;
    }
    this.closeTurn(now);
  }

  /** The user ended the call: the log goes to the host, and the line stops. */
  end(): void {
    if (this.ended) return;
    if (this.state === 'live' && !this.cur.over) {
      this.closeTurn();
      this.recordQuality();
      this.flushLog();
    }
    this.ended = true;
    this.cur.over = true;
    this.stopTimers();
  }

  private dial(resumes: string | null): void {
    this.cur = CallLine.attempt(this.cur.n + 1, this.clock.now());
    const attempt = this.cur.n;
    // Cleared on the ack and whenever the attempt is written off.
    this.ackTimer = this.clock.setTimeout(() => {
      this.ackTimer = null;
      const secs = Math.round(CALL_ACK_TIMEOUT_MS / 1000);
      this.lost(attempt, 'connect_timeout', `no answer from the host after ${secs}s`);
      this.surface.hangUp(attempt);
    }, CALL_ACK_TIMEOUT_MS);
    this.surface.dial(attempt, resumes);
  }

  /** The resume window ran out: the call is over, and no new session is opened. */
  private giveUp(): void {
    if (this.ended) return;
    const attempt = this.cur.n;
    const inFlight = !this.cur.over;
    this.ended = true;
    this.cur.over = true;
    this.stopTimers();
    if (inFlight) this.surface.hangUp(attempt);
    this.move('ended');
  }

  private scheduleRedial(): void {
    const last = CALL_RESUME_DELAYS_MS.length - 1;
    const delay = CALL_RESUME_DELAYS_MS[Math.min(this.redials, last)] as number;
    this.redials += 1;
    this.redialTimer = this.clock.setTimeout(() => {
      this.redialTimer = null;
      this.dial(this.lastLiveSessionId);
    }, delay);
  }

  private move(next: CallLinePhase, reason?: string): void {
    const prev = this.state;
    this.state = next;
    this.surface.phase(next, prev, reason);
  }

  private closeTurn(now = this.clock.now()): void {
    const t = this.turnAt;
    this.turnAt = null;
    if (t === null) return;
    const sessionId = this.lastLiveSessionId as string;
    const span = (a?: number, b?: number): number | undefined =>
      a !== undefined && b !== undefined ? Math.max(0, b - a) : undefined;
    const ended = t.replyAudioAt !== undefined ? now : undefined;
    const entry: CallLogEntry = { kind: 'turn', at: now, sessionId };
    const speechToTextMs = span(t.speechEndAt, t.transcriptAt);
    const modelMs = span(t.transcriptAt, t.replyAudioAt);
    const voiceMs = span(t.replyAudioAt, ended);
    if (speechToTextMs !== undefined) entry.speechToTextMs = speechToTextMs;
    if (modelMs !== undefined) entry.modelMs = modelMs;
    if (voiceMs !== undefined) entry.voiceMs = voiceMs;
    if (Object.keys(entry).length > 3) this.record(entry);
  }

  private recordQuality(): void {
    const q = this.cur.quality;
    const now = this.clock.now();
    const entry: CallLogEntry = {
      kind: 'quality',
      at: now,
      sessionId: this.cur.sessionId as string,
      heartbeats: q.heartbeats,
      lost: q.lost,
      late: q.late,
      maxGapMs: Math.max(q.maxGapMs, now - q.lastHeardAt),
    };
    if (q.rttCount > 0) {
      entry.rttMs = { min: q.rttMin, avg: Math.round(q.rttSum / q.rttCount), max: q.rttMax };
    }
    this.record(entry);
  }

  private record(entry: CallLogEntry): void {
    this.log.push(entry);
    if (this.log.length > CALL_LOG_MAX_ENTRIES) {
      this.log.shift();
      this.droppedEntries += 1;
    }
  }

  /**
   * Send what the log holds on the live attempt. Called when an attempt goes
   * live and when the call ends; a log that cannot be sent then waits for the
   * next.
   */
  private flushLog(): void {
    if (this.log.length === 0) return;
    const frame: AudioCallLogEvent = {
      type: 'audio.call_log',
      sessionId: this.cur.sessionId as string,
      entries: this.log,
    };
    if (this.droppedEntries > 0) frame.dropped = this.droppedEntries;
    if (!this.surface.send(this.cur.n, frame)) return;
    this.log = [];
    this.droppedEntries = 0;
  }

  private clear(timer: 'ackTimer' | 'redialTimer' | 'windowTimer' | 'silenceTimer'): void {
    if (this[timer] !== null) this.clock.clearTimeout(this[timer]);
    this[timer] = null;
  }

  private stopTimers(): void {
    this.clear('ackTimer');
    this.clear('redialTimer');
    this.clear('windowTimer');
    this.clear('silenceTimer');
  }
}
