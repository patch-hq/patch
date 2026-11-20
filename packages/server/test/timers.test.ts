import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { VoiceTimer } from '@patch/wire';
import { TimerService, speakDuration } from '../src/timers.js';

const logger = pino({ level: 'silent' });

describe('TimerService', () => {
  let dir: string;
  let changes: VoiceTimer[][];
  const make = (file?: string): TimerService =>
    new TimerService({
      logger,
      ...(file ? { file } : {}),
      onChanged: (t) => changes.push(t),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
    dir = mkdtempSync(join(tmpdir(), 'patch-timers-'));
    changes = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets a timer, reads it back, and rings it when it is done', () => {
    const svc = make();
    const out = svc.handle({
      type: 'voice.timers.request',
      requestId: 'r',
      action: 'set',
      seconds: 600,
      label: 'pasta',
      deviceId: 'kitchen',
    });
    expect(out).toEqual({ ok: true, message: 'Timer set: the pasta timer, 10 minutes.' });
    vi.advanceTimersByTime(4 * 60_000);
    const listed = svc.handle({ type: 'voice.timers.request', requestId: 'r', action: 'list' });
    expect(listed.message).toContain('the pasta timer has 6 minutes left');
    // Reading state never creates a timer.
    expect(svc.list()).toHaveLength(1);
    vi.advanceTimersByTime(6 * 60_000);
    expect(svc.list()[0]!.state).toBe('ringing');
    expect(changes.at(-1)![0]!.state).toBe('ringing');
    svc.close();
  });

  it('an alarm for a wall-clock time is kind alarm; a past time is refused', () => {
    const svc = make();
    const past = svc.handle({
      type: 'voice.timers.request',
      requestId: 'r',
      action: 'set',
      at: Date.now() - 1000,
    });
    expect(past.ok).toBe(false);
    const ok = svc.handle({
      type: 'voice.timers.request',
      requestId: 'r',
      action: 'set',
      at: Date.now() + 3600_000,
    });
    expect(ok.ok).toBe(true);
    expect(svc.list()[0]!.kind).toBe('alarm');
    svc.close();
  });

  it('changes and cancels by label, and says when the label is ambiguous', () => {
    const svc = make();
    const set = (label: string, seconds: number): void => {
      svc.handle({ type: 'voice.timers.request', requestId: 'r', action: 'set', seconds, label });
    };
    set('pasta', 600);
    set('pasta sauce', 300);
    const ambiguous = svc.handle({
      type: 'voice.timers.request',
      requestId: 'r',
      action: 'cancel',
      timer: 'pasta',
    });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.message).toContain('Several timers match');
    const changed = svc.handle({
      type: 'voice.timers.request',
      requestId: 'r',
      action: 'change',
      timer: 'sauce',
      addSeconds: 120,
    });
    expect(changed.message).toBe('the pasta sauce timer now has 7 minutes left.');
    const gone = svc.handle({
      type: 'voice.timers.request',
      requestId: 'r',
      action: 'cancel',
      timer: 'sauce',
    });
    expect(gone.ok).toBe(true);
    expect(svc.list().map((t) => t.label)).toEqual(['pasta']);
    svc.close();
  });

  it('stopping a ringing timer removes it; an unknown id is reported', () => {
    const svc = make();
    svc.handle({ type: 'voice.timers.request', requestId: 'r', action: 'set', seconds: 5 });
    vi.advanceTimersByTime(5000);
    const id = svc.list()[0]!.id;
    expect(svc.stop(id)).toBe(true);
    expect(svc.stop(id)).toBe(false);
    expect(svc.list()).toEqual([]);
    svc.close();
  });

  it('a ringing timer nobody stops is silenced after ten minutes', () => {
    const svc = make();
    svc.handle({ type: 'voice.timers.request', requestId: 'r', action: 'set', seconds: 5 });
    vi.advanceTimersByTime(5000 + 10 * 60_000);
    expect(svc.list()).toEqual([]);
    svc.close();
  });

  it('survives a restart: running timers keep their time, and a corrupt file stops the server', () => {
    const file = join(dir, 'timers.json');
    const a = make(file);
    a.handle({
      type: 'voice.timers.request',
      requestId: 'r',
      action: 'set',
      seconds: 900,
      label: 'tea',
    });
    a.close();
    vi.advanceTimersByTime(60_000);
    const b = make(file);
    expect(b.list()).toHaveLength(1);
    expect(
      b.handle({ type: 'voice.timers.request', requestId: 'r', action: 'list' }).message,
    ).toContain('14 minutes left');
    b.close();
    writeFileSync(file, '{not json');
    expect(() => make(file)).toThrow();
  });

  it('says durations the way a person would', () => {
    expect(speakDuration(90_000)).toBe('1 minute 30 seconds');
    expect(speakDuration(3_900_000)).toBe('1 hour 5 minutes');
    expect(speakDuration(45_000)).toBe('45 seconds');
  });
});
