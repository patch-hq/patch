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
  it('names the host it is waiting for', () => {
    expect(queueChipLabel(1, false, undefined, null, 'Mac host')).toBe('Mac host offline');
    expect(queueChipTitle(1, false, undefined, null, 'Mac host')).toBe('Waiting for Mac host');
  });

  it('says the host is offline rather than that a turn is running', () => {
    expect(queueChipLabel(1, false)).toBe('Host offline');
    expect(queueChipLabel(3, false)).toBe('Host offline');
    expect(queueChipTitle(1, false)).toBe('Waiting for the host');
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
    expect(queueRelease(block, 0)).toBe('tool');
    expect(queueRelease(block, 1)).toBe('turn');
    expect(queueRelease(block, 2)).toBe('turn');
  });
});

describe('out of credit', () => {
  it('says paused, not just Queued, and when it resumes', () => {
    const at = new Date(2026, 9, 21, 20, 0).getTime();
    const label = queueChipLabel(1, true, 'tool', { resetsAt: at });
    expect(label).toMatch(/^Paused · out of credit · resumes /);
    expect(label).not.toContain('next tool call');
    expect(label).toMatch(/8:00|20:00/);
  });

  it('omits the time when the limit stated none', () => {
    expect(queueChipLabel(2, true, 'tool', { resetsAt: null })).toBe('Paused · out of credit');
  });

  it('host offline still wins', () => {
    expect(queueChipLabel(1, false, 'tool', { resetsAt: null })).toBe('Host offline');
  });

  it('derives the pause from a row: limit block or armed resume, not an overload', () => {
    expect(creditPause({})).toBeNull();
    expect(creditPause({ rateLimitResumingAt: 5000, resumeKind: 'overloaded' })).toBeNull();
    expect(creditPause({ limitBlock: { resetsAt: 7000 } })).toEqual({ resetsAt: 7000 });
    expect(creditPause({ limitBlock: {} })).toEqual({ resetsAt: null });
    expect(creditPause({ rateLimitResumingAt: 9000, resumeKind: 'rate_limit' })).toEqual({
      resetsAt: 9000,
    });
  });
});
