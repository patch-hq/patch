import { describe, expect, it } from 'vitest';
import { cutTurnMessage } from '../src/sdkBackend.js';

describe('cutTurnMessage', () => {
  it('says how claude ended', () => {
    expect(cutTurnMessage('tool_use', 'claude exited code=null signal=SIGKILL')).toMatch(
      /had not finished.*signal=SIGKILL/,
    );
  });
  it('says nothing about the exit when it is unknown', () => {
    expect(cutTurnMessage(undefined)).not.toMatch(/exited code/);
  });
});
