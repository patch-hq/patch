// spec/04 ## Message queueing — the chip on a queued turn says WHEN it goes in:
// the head of the queue reads `Queued`, the rest read their place in the line,
// and each names the event that releases it.

import { describe, it, expect } from 'vitest';
import { queueChipLabel, queueChipTitle, queueRelease, creditPause } from '../lib/queueLabel';

describe('queueChipLabel', () => {
  it('reads "Queued" at the head of the queue', () => {
    expect(queueChipLabel(1)).toBe('Queued');
  });

  it('reads the ordinal place for everything behind the head', () => {
    expect(queueChipLabel(2)).toBe('2nd in queue');
    expect(queueChipLabel(3)).toBe('3rd in queue');
    expect(queueChipLabel(4)).toBe('4th in queue');
  });

  // A queue this deep is unlikely, but a wrong ordinal is the kind of thing
  // that reads as a bug in the whole panel.
  it('gets the awkward ordinals right', () => {
    expect(queueChipLabel(11)).toBe('11th in queue');
    expect(queueChipLabel(12)).toBe('12th in queue');
    expect(queueChipLabel(13)).toBe('13th in queue');
    expect(queueChipLabel(21)).toBe('21st in queue');
    expect(queueChipLabel(22)).toBe('22nd in queue');
    expect(queueChipLabel(23)).toBe('23rd in queue');
    expect(queueChipLabel(111)).toBe('111th in queue');
  });
});

describe('queueChipTitle', () => {
  it('names the running turn as the release event for the head', () => {
    expect(queueChipTitle(1)).toBe('Runs when the current turn finishes');
  });

  it('counts what is ahead for the rest, singular and plural', () => {
    expect(queueChipTitle(2)).toBe('Runs after the current turn and 1 message ahead of it');
    expect(queueChipTitle(3)).toBe('Runs after the current turn and 2 messages ahead of it');
  });
});

describe('host offline', () => {
  it('says the host is offline rather than that a turn is running', () => {
    expect(queueChipLabel(1, false)).toBe('Host offline');
    expect(queueChipLabel(3, false)).toBe('Host offline');
    expect(queueChipTitle(1, false)).toBe('Waiting for the host to come back online');
  });
});

describe('release event', () => {
  it('says a plain message goes in at the next tool call', () => {
    expect(queueChipLabel(1, true, 'tool')).toBe('Queued · next tool call');
    expect(queueChipLabel(2, true, 'tool')).toBe('2nd in queue · next tool call');
    expect(queueChipTitle(1, true, 'tool')).toBe(
      'Goes in when the agent finishes its current tool call',
    );
  });

  it('says a turn of its own goes in when the turn ends', () => {
    expect(queueChipLabel(1, true, 'turn')).toBe('Queued · end of turn');
    expect(queueChipTitle(1, true, 'turn')).toBe('Runs when the current turn finishes');
  });

  it('host offline wins over the release event', () => {
    expect(queueChipLabel(1, false, 'tool')).toBe('Host offline');
  });

  it('holds everything behind a turn that needs its own run', () => {
    const block = [{}, { queuedOwnTurn: true }, {}];
    expect(queueRelease(block, 0, true)).toBe('tool');
    expect(queueRelease(block, 1, true)).toBe('turn');
    expect(queueRelease(block, 2, true)).toBe('turn');
  });

  it('waits for the turn to end on a provider that does not declare steer', () => {
    expect(queueRelease([{}, {}], 0, false)).toBe('turn');
    expect(queueRelease([{}, {}], 1, false)).toBe('turn');
  });
});

describe('a paused chat, from the server status (decision 35)', () => {
  const NOW = new Date(2026, 10, 20, 19, 40).getTime();
  const AT = new Date(2026, 10, 20, 20, 30).getTime();
  const paused = (reason = 'session', resetsAt: number | undefined = AT) => ({
    chatStatus: { state: 'paused', reason, ...(resetsAt !== undefined ? { resetsAt } : {}) },
  });

  it('a session limit says so, and when it resumes', () => {
    const pause = creditPause(paused());
    expect(pause).toEqual({ kind: 'limit', scope: 'session', resetsAt: AT });
    const label = queueChipLabel(1, true, 'tool', pause, NOW);
    expect(label).toMatch(/^Paused · session limit · resumes \S*(8:30|20:30)/);
    expect(label).not.toContain('out of credit');
    expect(label).not.toContain('next tool call');
    expect(queueChipTitle(1, true, 'tool', pause, NOW)).toBe(
      'The session limit was reached; this runs once it resets',
    );
  });

  it('a weekly limit names the week', () => {
    expect(queueChipLabel(1, true, 'tool', creditPause(paused('week')), NOW)).toMatch(
      /^Paused · weekly limit · resumes /,
    );
  });

  it('a reset in the past is never a future promise: it says resuming', () => {
    const after = AT + 90 * 60_000;
    expect(queueChipLabel(1, true, 'tool', creditPause(paused()), after)).toBe(
      'Paused · session limit · resuming…',
    );
    expect(queueChipTitle(1, true, 'tool', creditPause(paused()), after)).toBe(
      'The session limit has reset; this runs once the paused turn resumes',
    );
  });

  it('only the account’s own out state says out of credit, with no resume time', () => {
    const out = creditPause({ chatStatus: { state: 'failed', reason: 'out_of_credit' } });
    expect(out).toEqual({ kind: 'out', resetsAt: null });
    expect(queueChipLabel(2, true, 'tool', out, NOW)).toBe('Paused · out of credit');
    // A limit with no reset known is a limit, not out of credit.
    const noReset = creditPause({ chatStatus: { state: 'failed', reason: 'limit_no_reset' } });
    expect(queueChipLabel(1, true, 'tool', noReset, NOW)).toBe('Paused · usage limit');
  });

  it('a pause that waits for the user promises no time', () => {
    expect(
      queueChipLabel(
        1,
        true,
        'tool',
        creditPause({ ...paused(), limitNext: 'switch_provider' }),
        NOW,
      ),
    ).toBe('Paused · session limit');
  });

  it('host offline still wins', () => {
    expect(queueChipLabel(1, false, 'tool', creditPause(paused()), NOW)).toBe('Host offline');
  });

  it('is nothing for a chat the server does not call paused, whatever the host fields say', () => {
    expect(creditPause({})).toBeNull();
    expect(creditPause({ chatStatus: { state: 'running' } })).toBeNull();
    expect(creditPause({ chatStatus: { state: 'failed', reason: 'sdk_error' } })).toBeNull();
    expect(creditPause({ chatStatus: { state: 'waiting_for_sign_in' } })).toEqual({
      kind: 'signed_out',
      resetsAt: null,
    });
  });
});
