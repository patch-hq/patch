// Timers and alarms for voice devices (spec/16 § Timers and alarms). Patch keeps
// the state, not the voice session: a conversation ends seconds after "set a
// timer", and the timer must outlive it, survive a restart, and be readable
// from any device or display. The store is persisted atomically (temp file +
// rename); a file that exists but cannot be read stops the server loudly
// rather than silently forgetting every timer.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Logger } from 'pino';
import { VoiceTimer, type VoiceTimersRequestEvent } from '@patch/wire';

const StoreFile = z.object({ timers: z.array(VoiceTimer) }).strict();

/** A ringing timer that nobody stops is silenced after this long and removed. */
export const RING_LIMIT_MS = 10 * 60_000;

export interface TimersDeps {
  logger: Logger;
  /** Where the timers are kept; absent keeps them in memory only (tests). */
  file?: string;
  now?: () => number;
  /** Called after any change, with every live timer. */
  onChanged: (timers: VoiceTimer[]) => void;
}

export interface TimerOutcome {
  ok: boolean;
  message: string;
}

/** "3 minutes 20 seconds", "45 seconds", "1 hour 5 minutes". */
export function speakDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const part = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const out: string[] = [];
  if (h > 0) out.push(part(h, 'hour'));
  if (m > 0) out.push(part(m, 'minute'));
  if (s > 0 && h === 0) out.push(part(s, 'second'));
  return out.length > 0 ? out.join(' ') : '0 seconds';
}

export class TimerService {
  private timers: VoiceTimer[] = [];
  private readonly handles = new Map<string, NodeJS.Timeout>();
  private readonly now: () => number;

  constructor(private readonly deps: TimersDeps) {
    this.now = deps.now ?? Date.now;
    if (deps.file && existsSync(deps.file)) {
      // NO FALLBACK: a corrupt store throws here and the server will not start.
      this.timers = StoreFile.parse(JSON.parse(readFileSync(deps.file, 'utf8'))).timers;
    }
    for (const t of this.timers) this.arm(t);
  }

  list(): VoiceTimer[] {
    return this.timers.map((t) => ({ ...t }));
  }

  close(): void {
    for (const h of this.handles.values()) clearTimeout(h);
    this.handles.clear();
  }

  /** The user stopped a ringing timer, or cancelled a running one. */
  stop(id: string): boolean {
    const idx = this.timers.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this.remove(id);
    this.changed();
    return true;
  }

  handle(req: VoiceTimersRequestEvent): TimerOutcome {
    switch (req.action) {
      case 'list':
        return { ok: true, message: this.describeAll() };
      case 'set':
        return this.set(req);
      case 'cancel':
      case 'change': {
        const found = this.pick(req.timer ?? '');
        if (typeof found === 'string') return { ok: false, message: found };
        if (req.action === 'cancel') {
          this.stop(found.id);
          return { ok: true, message: `Cancelled ${this.name(found)}.` };
        }
        return this.change(found, req);
      }
    }
  }

  private set(req: VoiceTimersRequestEvent): TimerOutcome {
    const now = this.now();
    let endsAt: number;
    let kind: VoiceTimer['kind'];
    if (req.at !== undefined) {
      endsAt = req.at;
      kind = 'alarm';
    } else if (req.seconds !== undefined) {
      endsAt = now + Math.round(req.seconds * 1000);
      kind = 'timer';
    } else {
      return { ok: false, message: 'Say how long, or what time.' };
    }
    if (endsAt <= now) return { ok: false, message: 'That time has already passed.' };
    const timer: VoiceTimer = {
      id: randomBytes(4).toString('hex'),
      label: (req.label ?? '').trim(),
      kind,
      endsAt,
      totalMs: endsAt - now,
      state: 'running',
      ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
    };
    this.timers.push(timer);
    this.arm(timer);
    this.changed();
    return {
      ok: true,
      message:
        kind === 'alarm'
          ? `Alarm set for ${this.name(timer)}, in ${speakDuration(timer.totalMs)}.`
          : `Timer set: ${this.name(timer)}, ${speakDuration(timer.totalMs)}.`,
    };
  }

  private change(found: VoiceTimer, req: VoiceTimersRequestEvent): TimerOutcome {
    const now = this.now();
    if (found.state === 'ringing') {
      return {
        ok: false,
        message: `${this.name(found)} is already ringing; it cannot be changed.`,
      };
    }
    let endsAt: number;
    if (req.setSeconds !== undefined) endsAt = now + Math.round(req.setSeconds * 1000);
    else if (req.addSeconds !== undefined)
      endsAt = found.endsAt + Math.round(req.addSeconds * 1000);
    else return { ok: false, message: 'Say the new time, or how much to add or take off.' };
    if (endsAt <= now)
      return { ok: false, message: 'That would be in the past. Cancel it instead.' };
    found.endsAt = endsAt;
    // The display's "how much is left" bar is against the longest the timer has been.
    found.totalMs = Math.max(found.totalMs, endsAt - now);
    this.arm(found);
    this.changed();
    return {
      ok: true,
      message: `${this.name(found)} now has ${speakDuration(endsAt - now)} left.`,
    };
  }

  /** One timer by id or label; a message when none or several match. */
  private pick(which: string): VoiceTimer | string {
    if (this.timers.length === 0) return 'There are no timers.';
    const q = which.trim().toLowerCase();
    if (q === '') {
      if (this.timers.length === 1) return this.timers[0]!;
      return `There are ${this.timers.length} timers: ${this.names()}. Ask which one.`;
    }
    const byId = this.timers.find((t) => t.id === q);
    if (byId) return byId;
    const hits = this.timers.filter((t) => t.label.toLowerCase().includes(q));
    if (hits.length === 1) return hits[0]!;
    if (hits.length === 0) return `No timer matches "${which}". The timers are: ${this.names()}.`;
    return `Several timers match "${which}": ${hits.map((t) => this.name(t)).join(', ')}. Ask which one.`;
  }

  private name(t: VoiceTimer): string {
    return t.label !== ''
      ? `the ${t.label} ${t.kind}`
      : `the ${speakDuration(t.totalMs)} ${t.kind}`;
  }

  private names(): string {
    return this.timers.map((t) => `${this.name(t)} (id ${t.id})`).join(', ');
  }

  /** The state as read out: how long each has left, or that it is ringing. */
  private describeAll(): string {
    if (this.timers.length === 0) return 'There are no timers or alarms set.';
    const now = this.now();
    return this.timers
      .map((t) =>
        t.state === 'ringing'
          ? `${this.name(t)} is ringing now (id ${t.id})`
          : `${this.name(t)} has ${speakDuration(t.endsAt - now)} left (id ${t.id})`,
      )
      .join('; ');
  }

  private arm(t: VoiceTimer): void {
    const old = this.handles.get(t.id);
    if (old) clearTimeout(old);
    if (t.state === 'ringing') {
      this.handles.set(
        t.id,
        this.later(t, RING_LIMIT_MS, () => this.silence(t.id)),
      );
      return;
    }
    this.handles.set(
      t.id,
      this.later(t, Math.max(0, t.endsAt - this.now()), () => this.ring(t.id)),
    );
  }

  /** setTimeout is capped near 24.8 days; re-arm in slices for anything longer. */
  private later(t: VoiceTimer, ms: number, fn: () => void): NodeJS.Timeout {
    const MAX = 2 ** 31 - 1;
    const h = setTimeout(
      () => (ms > MAX ? this.handles.set(t.id, this.later(t, ms - MAX, fn)) : fn()),
      Math.min(ms, MAX),
    );
    h.unref();
    return h;
  }

  private ring(id: string): void {
    const t = this.timers.find((x) => x.id === id);
    if (!t || t.state === 'ringing') return;
    t.state = 'ringing';
    this.arm(t);
    this.changed();
    this.deps.logger.info({ timerId: id, label: t.label, deviceId: t.deviceId }, 'timers: ringing');
  }

  private silence(id: string): void {
    this.deps.logger.warn({ timerId: id }, 'timers: nobody stopped it; silenced');
    this.stop(id);
  }

  private remove(id: string): void {
    this.timers = this.timers.filter((t) => t.id !== id);
    const h = this.handles.get(id);
    if (h) clearTimeout(h);
    this.handles.delete(id);
  }

  private changed(): void {
    this.persist();
    this.deps.onChanged(this.list());
  }

  private persist(): void {
    const file = this.deps.file;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ timers: this.timers }));
    renameSync(tmp, file);
  }
}
