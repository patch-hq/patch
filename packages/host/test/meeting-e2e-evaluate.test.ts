import { describe, expect, it } from 'vitest';
import { evaluate, reportLine, type Observed } from '../scripts/meeting-e2e/evaluate.js';
import {
  EXPECTED_ACTIONS,
  layout,
  MIC_CHECK,
  PARTICIPANTS,
  SCRIPT,
  type Step,
} from '../scripts/meeting-e2e/scenario.js';

const lineSteps = SCRIPT.filter((s) => s.kind === 'line');
const timeline = layout(
  SCRIPT,
  lineSteps.map(() => 5),
);

/** A transcript that heard every scripted line, named, in the right lane. */
function perfect(): Observed {
  const transcript = timeline.lines.map((l, i) => ({
    at: i,
    speaker: l.who === 'owner' ? ('you' as const) : ('them' as const),
    ...(l.who === 'owner' ? {} : { name: PARTICIPANTS[l.who] }),
    text: l.text,
  }));
  transcript.push({ at: 99, speaker: 'you', text: MIC_CHECK });
  return {
    state: {
      status: 'ended',
      transcript,
      topics: [
        { id: 't1', title: 'Budget', points: ['420k'], decided: false },
        { id: 't2', title: 'Launch date', points: ['moved to March'], decided: true },
        { id: 't3', title: 'Security review', points: ['tests pending'], decided: true },
      ] as never,
      actions: EXPECTED_ACTIONS.map((a, i) => ({
        id: `a${i}`,
        kind: 'mine' as const,
        title: a.name,
        why: a.name,
        at: 0,
        status: 'open' as const,
      })) as never,
      summary: null,
      error: null,
    },
    lines: timeline.lines,
    events: [
      { type: 'meeting:prompt-shown', payload: { app: 'Microsoft Teams' } },
      { type: 'meeting:detection-restart' },
      { type: 'meeting:auto-ended' },
    ],
    micOpens: 2,
  };
}

describe('layout', () => {
  it('places the mic switch after the pre-switch lines and the owner after it', () => {
    expect(timeline.switchAt).toBeGreaterThan(40);
    const post = timeline.lines.filter((l) => l.who === 'owner' && l.start >= timeline.switchAt);
    expect(post.length).toBeGreaterThan(0);
    expect(timeline.stretches.map((s) => s.kind)).toEqual(['silence', 'music', 'silence']);
  });

  it('refuses an owner line right after the switch', () => {
    const steps: Step[] = [
      { kind: 'line', who: 'owner', text: 'a b c' },
      { kind: 'mic-switch' },
      { kind: 'line', who: 'owner', text: 'd e f' },
    ];
    expect(() => layout(steps, [3, 3])).toThrow(/too closely/);
  });
});

describe('evaluate', () => {
  it('passes a run where everything happened', () => {
    const v = evaluate(perfect());
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(reportLine(v)).toMatch(/^PASS meeting-e2e: 10\/10/);
  });

  it('fails a line that was never transcribed', () => {
    const o = perfect();
    o.state.transcript = o.state.transcript.filter((t) => !/venue/.test(t.text));
    const v = evaluate(o);
    expect(v.checks.find((c) => c.name === 'every scripted line transcribed')?.ok).toBe(false);
    expect(reportLine(v)).toMatch(/^FAIL/);
  });

  it('fails an invented line in a quiet stretch', () => {
    const o = perfect();
    o.state.transcript.push({
      at: 50,
      speaker: 'them',
      text: 'Thank you for watching, see you next time.',
    });
    expect(evaluate(o).checks.find((c) => c.name === 'no invented lines')?.ok).toBe(false);
  });

  it('ignores a one-word fragment', () => {
    const o = perfect();
    o.state.transcript.push({ at: 50, speaker: 'them', text: 'Okay.' });
    expect(evaluate(o).checks.find((c) => c.name === 'no invented lines')?.ok).toBe(true);
  });

  it('fails when the speakers were not named', () => {
    const o = perfect();
    o.state.transcript = o.state.transcript.map((t) => ({ ...t, name: undefined }));
    expect(evaluate(o).checks.find((c) => c.name === 'speakers named')?.ok).toBe(false);
  });

  it('fails when the mic was only opened once', () => {
    const o = perfect();
    o.micOpens = 1;
    expect(evaluate(o).checks.find((c) => c.name === 'mic change followed')?.ok).toBe(false);
  });

  it('fails when the check line was heard on one mic only', () => {
    const o = perfect();
    o.state.transcript = o.state.transcript.filter(
      (t, i, all) => t.text !== MIC_CHECK || i === all.findIndex((x) => x.text === MIC_CHECK),
    );
    // Only one check line left: the switched mic never spoke.
    const first = o.state.transcript.filter((t) => t.text === MIC_CHECK).length;
    expect(first).toBe(1);
    expect(evaluate(o).checks[0]?.ok).toBe(false);
  });

  it('fails when the meeting did not end itself, the prompt never fired or the watcher never restarted', () => {
    const o = perfect();
    o.events = [];
    o.state.status = 'live' as never;
    const failed = evaluate(o)
      .checks.filter((c) => !c.ok)
      .map((c) => c.name);
    expect(failed).toEqual(['start prompt fired', 'meeting ended itself', 'mic watcher restarted']);
  });
});
