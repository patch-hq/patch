import { describe, it, expect } from 'vitest';
import { turnStartOf } from '../src/lib/backgroundTasks';

describe('turnStartOf', () => {
  it('is the latest user message that is not queued', () => {
    expect(
      turnStartOf([
        { kind: 'message', role: 'user', at: 1 },
        { kind: 'message', role: 'assistant', at: 2 },
        { kind: 'message', role: 'user', at: 3, messageAt: 10 },
        { kind: 'message', role: 'user', at: 4, queued: true },
        { kind: 'tool_call', at: 5 },
      ]),
    ).toBe(10);
  });
  it('is undefined with no user message', () => {
    expect(turnStartOf([{ kind: 'tool_call', at: 5 }])).toBeUndefined();
    expect(turnStartOf(undefined)).toBeUndefined();
  });
});
