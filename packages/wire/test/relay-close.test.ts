// closeAsRelayed — a relayed audio socket closes the way its far end closed
// (spec/07 § The agent ends the call: a clean hang-up is never read as a drop).

import { describe, it, expect, vi } from 'vitest';
import { closeAsRelayed } from '../src/events.js';

describe('closeAsRelayed', () => {
  it('passes a sendable close through with its reason', () => {
    for (const [code, reason] of [
      [1000, 'ended_by_agent'],
      [1000, 'transferred'],
      [1001, 'going away'],
      [1011, 'internal'],
      [4400, 'gemini failed'],
    ] as const) {
      const close = vi.fn();
      closeAsRelayed({ close }, code, reason);
      expect(close).toHaveBeenCalledWith(code, reason);
    }
  });

  it('closes bare when the far end only reported a close it could not send', () => {
    for (const code of [1004, 1005, 1006, 1015, 2000, 5000]) {
      const close = vi.fn();
      closeAsRelayed({ close }, code, '');
      expect(close).toHaveBeenCalledWith();
    }
  });
});
