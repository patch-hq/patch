import { describe, it, expect } from 'vitest';
import { formatAgentReturn, parseAgentReturn } from '../src/index.js';

describe('agent return', () => {
  it('round-trips title, id and a multi-line reply', () => {
    const text = formatAgentReturn('Folk history', 'abc-123', 'line one\n\nline two');
    expect(parseAgentReturn(text)).toEqual({
      title: 'Folk history',
      id: 'abc-123',
      reply: 'line one\n\nline two',
    });
  });
  it('leaves ordinary text alone', () => {
    expect(parseAgentReturn('[from the user] hello')).toBeNull();
    expect(parseAgentReturn('hello')).toBeNull();
  });
});
