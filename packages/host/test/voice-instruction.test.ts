import { describe, test, expect } from 'vitest';
import { HOSTED_VOICE_INSTRUCTION, hostedVoiceInstruction } from '../src/audio/gemini-live.js';

describe('HOSTED_VOICE_INSTRUCTION', () => {
  test('allows one acknowledgement then silence until the agent result arrives', () => {
    expect(HOSTED_VOICE_INSTRUCTION).toMatch(/at most one/i);
    expect(HOSTED_VOICE_INSTRUCTION).toMatch(/silent|say nothing/i);
    expect(HOSTED_VOICE_INSTRUCTION).toMatch(/never repeat|do not repeat/i);
    expect(HOSTED_VOICE_INSTRUCTION).not.toMatch(/so you are never silent/i);
  });

  test('forbids answering from guesses what only the agent can know', () => {
    expect(HOSTED_VOICE_INSTRUCTION).toMatch(/never guess|do not guess|never make up/i);
    expect(HOSTED_VOICE_INSTRUCTION).toMatch(/files/i);
  });

  test('the async variant keeps the voice talking while the agent works, and says the result when it arrives', () => {
    const text = hostedVoiceInstruction('auto', true);
    expect(text).toMatch(/answers at once/i);
    expect(text).toMatch(/carry on the conversation/i);
    expect(text).toMatch(/never say "still working on it"/i);
    expect(text).toMatch(/result arrives as a message/i);
    expect(text).toMatch(/never guess/i);
  });

  test('auto: general questions are answered or dispatched, never bounced back for context', () => {
    for (const async of [false, true]) {
      const text = hostedVoiceInstruction('auto', async);
      expect(text).toMatch(/general factual question/i);
      expect(text).toMatch(/own knowledge/i);
      expect(text).toMatch(/never ask the user for more context/i);
      expect(text).toMatch(/never ask whether/i);
      expect(text).toMatch(/already with the agent/i);
    }
  });

  test.each(['auto', 'always'] as const)(
    '%s: no claiming an action without its tool result',
    (mode) => {
      for (const async of [false, true]) {
        const text = hostedVoiceInstruction(mode, async);
        expect(text).toMatch(/never say you have (added|passed|checked)|never claim/i);
        expect(text).toMatch(/<noise>/);
      }
    },
  );

  test('unknown facts go to the agent, in-flight hand-offs are remembered, answers stay short', () => {
    const text = hostedVoiceInstruction('auto', true);
    expect(text).toMatch(/never say you do not know/i);
    expect(text).toMatch(/general factual/i);
    expect(text).toMatch(/stays in progress/i);
    expect(text).toMatch(/one or two short sentences/i);
  });
});
