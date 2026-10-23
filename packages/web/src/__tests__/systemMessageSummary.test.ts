import { describe, expect, it } from 'vitest';
import { systemMessageSummary } from '../lib/systemMessageSummary';

describe('systemMessageSummary', () => {
  it('names a self-wake with what it was for', () => {
    expect(systemMessageSummary('[wake] check the deploy\nmore', 'machine')).toBe(
      'Woke itself — check the deploy',
    );
  });
  it('names a watch update, using the next line when the tag line is bare', () => {
    expect(systemMessageSummary('[watch]\nbuild finished', 'machine')).toBe(
      'Watch update — build finished',
    );
  });
  it('names the todo list advancing', () => {
    expect(systemMessageSummary('[todo] write tests', 'machine')).toBe('Next todo — write tests');
  });
  it('names a manager sweep by how many chats changed', () => {
    expect(systemMessageSummary('3 chats changed:\n\n- a', 'machine')).toBe(
      'Manager check-in — 3 chats changed',
    );
  });
  it('keeps a Pad delivery line as is', () => {
    expect(systemMessageSummary('[Pad] Tom sent 2 changes\nbody', 'job')).toBe(
      '[Pad] Tom sent 2 changes',
    );
  });
  it('labels a job fire and any other machine message with a clipped first line', () => {
    expect(systemMessageSummary('run the report', 'job')).toBe('Job fired — run the report');
    const long = 'x'.repeat(200);
    const s = systemMessageSummary(long, 'machine');
    expect(s.startsWith('Automated message — xxx')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThan(110);
  });
  it('falls back to the bare label for empty content', () => {
    expect(systemMessageSummary('', 'machine')).toBe('Automated message');
  });
});
