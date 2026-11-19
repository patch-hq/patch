import { describe, expect, it } from 'vitest';
import { agentHeldHistory } from '../src/history.js';

// An ACP agent (Gemini CLI) keeps its own session; Patch never reads it.
describe('agentHeldHistory', () => {
  it('treats a named session as the agent’s to resume, so turns after the first keep it', () => {
    expect(agentHeldHistory.hasSession({ folder: '/w', sessionId: 'gemini-abc' })).toBe(true);
  });
  it('has nothing to page, fork or side from', () => {
    expect(agentHeldHistory.read({ folder: '/w', sessionId: 'gemini-abc' } as never)).toEqual([]);
    expect(
      agentHeldHistory.forkPoint({ folder: '/w', sessionId: 'gemini-abc', seq: 1 } as never),
    ).toBeNull();
    expect(
      agentHeldHistory.sidePoint({ folder: '/w', sessionId: 'gemini-abc', seq: 1 } as never),
    ).toBeNull();
  });
});
