// The line under a call (spec/07 § A dropped call comes back, § Call logs),
// driven on a fake clock.

import { describe, expect, test, beforeEach } from 'vitest';
import {
  CALL_ACK_TIMEOUT_MS,
  CALL_REDIAL_DELAYS_MS,
  CallLine,
  type CallLineClock,
  type CallLinePhase,
  type CallLineSurface,
} from '../src/call-line.js';
import {
  CALL_LOG_MAX_ENTRIES,
  HEARTBEAT_LOST_AFTER_MS,
  type AudioCallLogEvent,
  type AudioHeartbeatEvent,
} from '../src/audio.js';

class FakeClock implements CallLineClock {
  t = 1_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, v]) => v.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
  }
  pending(): number {
    return this.timers.size;
  }
}

class Surface implements CallLineSurface {
  dials: Array<{ attempt: number; resumed: boolean }> = [];
  hungUp: number[] = [];
  sent: Array<{ attempt: number; frame: AudioHeartbeatEvent | AudioCallLogEvent }> = [];
  phases: Array<{ next: CallLinePhase; prev: CallLinePhase; reason?: string }> = [];
  tries: string[] = [];
  open = true;
  stillTrying(reason: string): void {
    this.tries.push(reason);
  }
  dial(attempt: number, resumed: boolean): void {
    this.dials.push({ attempt, resumed });
  }
  hangUp(attempt: number): void {
    this.hungUp.push(attempt);
  }
  send(attempt: number, frame: AudioHeartbeatEvent | AudioCallLogEvent): boolean {
    if (!this.open) return false;
    this.sent.push({ attempt, frame });
    return true;
  }
  phase(next: CallLinePhase, prev: CallLinePhase, reason?: string): void {
    this.phases.push(reason === undefined ? { next, prev } : { next, prev, reason });
  }
  logs(): AudioCallLogEvent[] {
    return this.sent.map((s) => s.frame).filter((f) => f.type === 'audio.call_log');
  }
  echoes(): AudioHeartbeatEvent[] {
    return this.sent.map((s) => s.frame).filter((f) => f.type === 'audio.heartbeat');
  }
}

let clock: FakeClock;
let surface: Surface;
let line: CallLine;

function hb(n: number, sessionId = 's1', rttMs?: number): AudioHeartbeatEvent {
  return { type: 'audio.heartbeat', sessionId, n, ...(rttMs !== undefined ? { rttMs } : {}) };
}

/** Place the call and bring it live on session `s1`. */
function live(): void {
  line.start();
  line.acked(1, 's1');
}

beforeEach(() => {
  clock = new FakeClock();
  surface = new Surface();
  line = new CallLine(surface, clock);
});

describe('placing a call', () => {
  test('dials once, and is live when the host acknowledges it', () => {
    line.start();
    expect(surface.dials).toEqual([{ attempt: 1, resumed: false }]);
    expect(line.phase).toBe('connecting');
    line.acked(1, 's1');
    expect(line.phase).toBe('live');
    expect(surface.phases).toEqual([{ next: 'live', prev: 'connecting' }]);
    // A second acknowledgement changes nothing.
    line.acked(1, 's1');
    expect(surface.phases).toHaveLength(1);
  });

  test('a first dial that never connects has failed, and is not redialled', () => {
    line.start();
    line.lost(1, 'connection_closed', 'token mint failed');
    expect(line.phase).toBe('failed');
    expect(surface.phases.at(-1)).toEqual({
      next: 'failed',
      prev: 'connecting',
      reason: 'token mint failed',
    });
    clock.advance(60_000);
    expect(surface.dials).toHaveLength(1);
  });

  test('a first dial the host never answers fails after the ack timeout, and is hung up', () => {
    line.start();
    clock.advance(CALL_ACK_TIMEOUT_MS - 1);
    expect(line.phase).toBe('connecting');
    clock.advance(1);
    expect(surface.hungUp).toEqual([1]);
    expect(surface.phases.at(-1)?.reason).toBe('no answer from the host after 15s');
  });
});

describe('a dropped call comes back', () => {
  test('a live line that closes redials on the schedule, as a resumed call', () => {
    live();
    line.lost(1, 'connection_closed', 'the audio connection closed');
    expect(line.phase).toBe('reconnecting');
    clock.advance(CALL_REDIAL_DELAYS_MS[0]! - 1);
    expect(surface.dials).toHaveLength(1);
    clock.advance(1);
    expect(surface.dials.at(-1)).toEqual({ attempt: 2, resumed: true });
    line.acked(2, 's2');
    expect(surface.phases.map((p) => p.next)).toEqual(['live', 'reconnecting', 'live']);
    expect(surface.phases.at(-1)?.prev).toBe('reconnecting');
  });

  test('a redial that fails tries again on the next delay, then keeps trying, saying so once', () => {
    live();
    line.lost(1, 'host_unreachable', 'host gone');
    let attempt = 1;
    for (const delay of CALL_REDIAL_DELAYS_MS) {
      clock.advance(delay);
      attempt += 1;
      expect(surface.dials.at(-1)).toEqual({ attempt, resumed: true });
      line.lost(attempt, 'connection_closed', 'still down');
    }
    expect(surface.tries).toEqual(['still down']);
    const last = CALL_REDIAL_DELAYS_MS.at(-1)!;
    clock.advance(last);
    line.lost(attempt + 1, 'connection_closed', 'still down');
    clock.advance(last);
    expect(surface.dials).toHaveLength(CALL_REDIAL_DELAYS_MS.length + 3);
    expect(surface.tries).toHaveLength(1);
    expect(line.phase).toBe('reconnecting');
  });

  test('a redial the host never answers is hung up and tried again', () => {
    live();
    line.lost(1, 'connection_closed', 'closed');
    clock.advance(CALL_REDIAL_DELAYS_MS[0]!);
    clock.advance(CALL_ACK_TIMEOUT_MS);
    expect(surface.hungUp).toEqual([2]);
    expect(line.phase).toBe('reconnecting');
    clock.advance(CALL_REDIAL_DELAYS_MS[1]!);
    expect(surface.dials.at(-1)).toEqual({ attempt: 3, resumed: true });
  });

  test('the schedule starts again after the line comes back', () => {
    live();
    line.lost(1, 'connection_closed', 'closed');
    clock.advance(CALL_REDIAL_DELAYS_MS[0]!);
    line.lost(2, 'connection_closed', 'closed');
    clock.advance(CALL_REDIAL_DELAYS_MS[1]!);
    line.acked(3, 's3');
    line.lost(3, 'connection_closed', 'closed');
    clock.advance(CALL_REDIAL_DELAYS_MS[0]!);
    expect(surface.dials.at(-1)).toEqual({ attempt: 4, resumed: true });
  });

  test('coming back to the foreground redials at once', () => {
    live();
    line.foreground();
    expect(surface.dials).toHaveLength(1);
    line.lost(1, 'connection_closed', 'closed');
    line.foreground();
    expect(surface.dials.at(-1)).toEqual({ attempt: 2, resumed: true });
    clock.advance(CALL_REDIAL_DELAYS_MS[0]!);
    expect(surface.dials).toHaveLength(2);
  });

  test('an attempt is lost once: the close after a heartbeat timeout is the same drop', () => {
    live();
    line.heartbeat(1, hb(0));
    clock.advance(HEARTBEAT_LOST_AFTER_MS);
    expect(surface.hungUp).toEqual([1]);
    line.lost(1, 'connection_closed', 'closed');
    expect(surface.phases.filter((p) => p.next === 'reconnecting')).toHaveLength(1);
    clock.advance(CALL_REDIAL_DELAYS_MS[0]!);
    expect(surface.dials).toHaveLength(2);
  });

  test('events from a replaced attempt change nothing', () => {
    live();
    line.lost(1, 'connection_closed', 'closed');
    clock.advance(CALL_REDIAL_DELAYS_MS[0]!);
    line.acked(1, 's1');
    line.heartbeat(1, hb(1));
    line.fail(1, 'late error');
    expect(line.phase).toBe('reconnecting');
    expect(line.isCurrent(2)).toBe(true);
    expect(line.isCurrent(1)).toBe(false);
  });
});

describe('heartbeats', () => {
  test('each is echoed with its number, and a line that hears them stays up', () => {
    live();
    for (let n = 0; n < 10; n++) {
      line.heartbeat(1, hb(n));
      clock.advance(1_000);
    }
    expect(surface.echoes().map((e) => e.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(surface.echoes()[0]).toEqual({ type: 'audio.heartbeat', sessionId: 's1', n: 0 });
    expect(line.phase).toBe('live');
  });

  test('three seconds with none after one has been heard is a lost line', () => {
    live();
    line.heartbeat(1, hb(0));
    clock.advance(HEARTBEAT_LOST_AFTER_MS - 1);
    expect(line.phase).toBe('live');
    clock.advance(1);
    expect(line.phase).toBe('reconnecting');
  });

  test('three seconds after the acknowledgement with no heartbeat is a lost line too', () => {
    live();
    clock.advance(HEARTBEAT_LOST_AFTER_MS - 1);
    expect(line.phase).toBe('live');
    clock.advance(1);
    expect(line.phase).toBe('reconnecting');
    expect(surface.hungUp).toEqual([1]);
  });

  test('heartbeats before the acknowledgement are echoed, and the ack timeout judges until then', () => {
    line.start();
    line.heartbeat(1, hb(0));
    clock.advance(HEARTBEAT_LOST_AFTER_MS * 2);
    expect(line.phase).toBe('connecting');
    expect(surface.echoes()).toHaveLength(1);
  });
});

describe('the call log', () => {
  test('a drop is logged with why and the connection quality, and sent once the line is back', () => {
    live();
    line.heartbeat(1, hb(0, 's1', 30));
    clock.advance(1_000);
    line.heartbeat(1, hb(1, 's1', 50));
    clock.advance(2_000); // late
    line.heartbeat(1, hb(4, 's1', 40)); // 2 and 3 never came
    clock.advance(HEARTBEAT_LOST_AFTER_MS);
    expect(surface.logs()).toEqual([]);
    clock.advance(CALL_REDIAL_DELAYS_MS[0]!);
    line.acked(2, 's2');
    const [log] = surface.logs();
    expect(log?.sessionId).toBe('s2');
    expect(log?.entries).toEqual([
      {
        kind: 'audio_stopped',
        at: expect.any(Number),
        sessionId: 's1',
        reason: 'signal_lost',
        detail: `nothing from the host for ${HEARTBEAT_LOST_AFTER_MS}ms`,
      },
      {
        kind: 'quality',
        at: expect.any(Number),
        sessionId: 's1',
        heartbeats: 3,
        lost: 2,
        late: 1,
        maxGapMs: HEARTBEAT_LOST_AFTER_MS,
        rttMs: { min: 30, avg: 40, max: 50 },
      },
      {
        kind: 'reconnected',
        at: expect.any(Number),
        sessionId: 's2',
        downMs: CALL_REDIAL_DELAYS_MS[0],
        attempts: 1,
      },
    ]);
    // Sent once, then cleared.
    line.heartbeat(2, hb(1, 's2'));
    expect(surface.logs()).toHaveLength(1);
  });

  test('a session with no heartbeat yet logs its quality from the acknowledgement', () => {
    live();
    clock.advance(1_000);
    line.lost(1, 'connection_closed', 'closed');
    clock.advance(CALL_REDIAL_DELAYS_MS[0]!);
    line.acked(2, 's2');
    expect(surface.logs()[0]?.entries[1]).toMatchObject({
      kind: 'quality',
      heartbeats: 0,
      maxGapMs: 1_000,
    });
  });

  test('times each step of a turn', () => {
    live();
    line.heartbeat(1, hb(0));
    line.turn('speech_end');
    clock.advance(300);
    line.turn('transcript');
    clock.advance(900);
    line.turn('reply_audio');
    line.turn('reply_audio');
    line.heartbeat(1, hb(1));
    clock.advance(2_000);
    line.turn('reply_end');
    // A reply end with no turn open, and a turn with nothing timed, log nothing.
    line.turn('reply_end');
    line.turn('reply_audio');
    line.end();
    const entries = surface.logs()[0]?.entries ?? [];
    expect(entries.filter((e) => e.kind === 'turn')).toEqual([
      {
        kind: 'turn',
        at: expect.any(Number),
        sessionId: 's1',
        speechToTextMs: 300,
        modelMs: 900,
        voiceMs: 2_000,
      },
    ]);
  });

  test('a turn cut short is logged with what it reached when the next begins', () => {
    live();
    line.heartbeat(1, hb(0));
    line.turn('transcript');
    clock.advance(500);
    line.turn('reply_audio');
    line.turn('speech_end');
    line.turn('speech_end');
    line.end();
    const turns = (surface.logs()[0]?.entries ?? []).filter((e) => e.kind === 'turn');
    expect(turns).toEqual([
      { kind: 'turn', at: expect.any(Number), sessionId: 's1', modelMs: 500, voiceMs: 0 },
    ]);
  });

  test('audio stopping on the device is logged while the line is up, and only then', () => {
    line.start();
    line.audioStopped('audio_focus_taken', 'before it connected');
    line.acked(1, 's1');
    line.heartbeat(1, hb(0));
    line.audioStopped('audio_focus_taken', 'AUDIOFOCUS_LOSS');
    line.turn('speech_end');
    line.end();
    line.audioStopped('output_device_changed', 'after it ended');
    line.turn('speech_end');
    const entries = surface.logs()[0]?.entries ?? [];
    expect(entries.map((e) => e.kind)).toEqual(['audio_stopped', 'quality']);
    expect(entries[0]).toMatchObject({ reason: 'audio_focus_taken', detail: 'AUDIOFOCUS_LOSS' });
  });

  test('a log that could not be sent is kept for the next chance', () => {
    live();
    line.heartbeat(1, hb(0));
    line.lost(1, 'connection_closed', 'closed');
    clock.advance(CALL_REDIAL_DELAYS_MS[0]!);
    surface.open = false;
    line.acked(2, 's2');
    line.heartbeat(2, hb(0, 's2'));
    surface.open = true;
    // Steady heartbeats do not send it; the end of the call does.
    line.heartbeat(2, hb(1, 's2'));
    expect(surface.logs()).toHaveLength(0);
    line.end();
    expect(surface.logs()[0]?.entries.map((e) => e.kind)).toEqual([
      'audio_stopped',
      'quality',
      'reconnected',
      'quality',
    ]);
  });

  test('a log that outgrows its cap drops the oldest entries and says how many', () => {
    live();
    line.heartbeat(1, hb(0));
    for (let i = 0; i < CALL_LOG_MAX_ENTRIES + 7; i++) {
      line.audioStopped('output_device_changed', `change ${i}`);
    }
    line.end();
    const [log] = surface.logs();
    expect(log?.entries).toHaveLength(CALL_LOG_MAX_ENTRIES);
    expect(log?.dropped).toBe(8);
    expect(log?.entries[0]).toMatchObject({ detail: 'change 8' });
  });

  test('ending the call sends the log, then the line stops for good', () => {
    live();
    line.heartbeat(1, hb(0));
    line.end();
    line.end();
    expect(surface.logs()).toHaveLength(1);
    expect(surface.logs()[0]?.entries.map((e) => e.kind)).toEqual(['quality']);
    expect(clock.pending()).toBe(0);
    line.foreground();
    line.lost(1, 'connection_closed', 'closed');
    expect(surface.dials).toHaveLength(1);
  });

  test('ending a call that is not live sends nothing and stops every timer', () => {
    live();
    line.lost(1, 'connection_closed', 'closed');
    line.end();
    expect(surface.logs()).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});

describe('a reported error', () => {
  test('fails the call, live or not, and the close that follows is not a drop', () => {
    live();
    line.fail(1, 'mic_silent: no audio');
    expect(surface.phases.at(-1)).toEqual({
      next: 'failed',
      prev: 'live',
      reason: 'mic_silent: no audio',
    });
    line.lost(1, 'connection_closed', 'closed');
    clock.advance(60_000);
    expect(surface.dials).toHaveLength(1);
  });
});

test('uses the real clock by default', () => {
  const real = new CallLine(surface);
  real.start();
  expect(real.attempt).toBe(1);
  real.acked(1, 's1');
  real.heartbeat(1, hb(0));
  real.end();
  expect(surface.logs()[0]?.entries[0]).toMatchObject({ kind: 'quality', heartbeats: 1 });
});
