// Judges one run of the synthetic meeting test. Everything here is a pure function
// of what the run observed, so the verdict is unit-tested without a Mac.

import type { MeetingState } from '@patch/wire';
import {
  CALL_APP_NAME,
  EXPECTED_ACTIONS,
  EXPECTED_TOPICS,
  MIC_CHECK,
  PARTICIPANTS,
  type TimedLine,
  type Who,
} from './scenario.js';

export interface DesktopEventSeen {
  type: string;
  payload?: Record<string, unknown>;
}

export interface Observed {
  state: Pick<
    MeetingState,
    'status' | 'transcript' | 'topics' | 'actions' | 'summary' | 'error'
  > & {
    writeup?: unknown;
  };
  /** The scripted lines, with the times they were played. */
  lines: readonly TimedLine[];
  events: readonly DesktopEventSeen[];
  /** How many times the page asked for a microphone (the first, and one per device change). */
  micOpens: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface Verdict {
  ok: boolean;
  checks: Check[];
}

/** Below this share of a line's words found, the line counts as not transcribed. */
export const LINE_COVERAGE = 0.7;
/** Below this share against EVERY scripted line, a transcript line was invented. */
export const INVENTED_BELOW = 0.45;
/** Shorter than this is a stray word, not a line worth calling invented. */
export const INVENTED_MIN_WORDS = 3;
export const NAMED_SHARE = 0.8;

export const words = (t: string): string[] =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');

/** Share of `a`'s words found in `b`. */
export function coverage(a: string, b: string): number {
  const wa = words(a);
  const wb = new Set(words(b));
  return wa.length === 0 ? 0 : wa.filter((w) => wb.has(w)).length / wa.length;
}

const lane = (who: Who): 'you' | 'them' => (who === 'owner' ? 'you' : 'them');

export function evaluate(o: Observed): Verdict {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const transcript = o.state.transcript;
  const laneText = (l: 'you' | 'them'): string =>
    transcript
      .filter((t) => t.speaker === l)
      .map((t) => t.text)
      .join(' ');

  // 1. Every scripted line, on the right lane. The mic check is said once per microphone.
  const missing: string[] = [];
  for (const line of o.lines) {
    if (coverage(line.text, laneText(lane(line.who))) < LINE_COVERAGE) missing.push(line.text);
  }
  const checkLines = transcript.filter(
    (t) => t.speaker === 'you' && coverage(MIC_CHECK, t.text) >= LINE_COVERAGE,
  ).length;
  if (checkLines < 2) missing.push(`${MIC_CHECK} (heard ${checkLines} of 2: the switched mic)`);
  add(
    'every scripted line transcribed',
    missing.length === 0,
    missing.length === 0
      ? `${o.lines.length}/${o.lines.length}`
      : `missing: ${missing.join(' | ')}`,
  );

  // 2. Nothing invented in the silent and music stretches (or anywhere else).
  const invented = transcript.filter((t) => {
    if (words(t.text).length < INVENTED_MIN_WORDS) return false;
    return o.lines.every((l) => coverage(t.text, l.text) < INVENTED_BELOW);
  });
  add(
    'no invented lines',
    invented.length === 0,
    invented.length === 0
      ? '0 invented'
      : `invented: ${invented.map((t) => `"${t.text}"`).join(' | ')}`,
  );

  // 3. Speakers named: each remote line carries the name the call app lit up.
  const remote = o.lines.filter((l) => l.who !== 'owner');
  const unnamed = remote.filter((l) => {
    const expected = PARTICIPANTS[l.who as 'priya' | 'marcus'];
    return !transcript.some(
      (t) => t.speaker === 'them' && t.name === expected && coverage(l.text, t.text) >= 0.3,
    );
  });
  const named = remote.length - unnamed.length;
  add(
    'speakers named',
    named / remote.length >= NAMED_SHARE,
    `${named}/${remote.length}` +
      (unnamed.length ? `; unnamed: ${unnamed.map((l) => l.who).join(',')}` : ''),
  );

  // 4. Notes cover every topic.
  const notes = JSON.stringify([o.state.topics, o.state.summary, o.state.writeup ?? null]);
  const uncovered = EXPECTED_TOPICS.filter((t) => !t.pattern.test(notes)).map((t) => t.name);
  add(
    'notes cover every topic',
    uncovered.length === 0,
    uncovered.length === 0
      ? `${EXPECTED_TOPICS.length}/${EXPECTED_TOPICS.length}`
      : `missing: ${uncovered.join(', ')}`,
  );

  // 5. Scripted actions present.
  const actionText = o.state.actions.map((a) => `${a.title} ${a.why}`).join('\n');
  const lost = EXPECTED_ACTIONS.filter((a) => !a.pattern.test(actionText)).map((a) => a.name);
  add(
    'scripted actions present',
    lost.length === 0,
    lost.length === 0
      ? `${EXPECTED_ACTIONS.length}/${EXPECTED_ACTIONS.length}`
      : `missing: ${lost.join(', ')}`,
  );

  // 6-9. What the desktop shell did.
  const seen = (type: string): DesktopEventSeen | undefined =>
    o.events.find((e) => e.type === type);
  const prompt = o.events.find(
    (e) => e.type === 'meeting:prompt-shown' && e.payload?.['app'] === CALL_APP_NAME,
  );
  add(
    'start prompt fired',
    prompt !== undefined,
    prompt ? CALL_APP_NAME : 'no meeting:prompt-shown',
  );
  add(
    'meeting ended itself',
    seen('meeting:auto-ended') !== undefined && o.state.status === 'ended',
    `event ${seen('meeting:auto-ended') ? 'yes' : 'no'}, status ${o.state.status}`,
  );
  add(
    'mic watcher restarted',
    seen('meeting:detection-restart') !== undefined,
    seen('meeting:detection-restart') ? 'restarted' : 'no meeting:detection-restart',
  );
  add('mic change followed', o.micOpens >= 2, `${o.micOpens} microphone opens`);
  add('no meeting error', !o.state.error, o.state.error ?? 'none');

  return { ok: checks.every((c) => c.ok), checks };
}

/** The one-line pass/fail report the nightly job posts. */
export function reportLine(v: Verdict): string {
  const passed = v.checks.filter((c) => c.ok).length;
  if (v.ok) return `PASS meeting-e2e: ${passed}/${v.checks.length} checks`;
  const failed = v.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
  return `FAIL meeting-e2e: ${passed}/${v.checks.length} checks; ${failed.join('; ')}`;
}
