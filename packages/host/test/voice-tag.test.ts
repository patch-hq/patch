// chatRunner.stripVoiceTag — removes the host's own `[voice …]` tag from a spoken turn.

import { describe, it, expect } from 'vitest';
import { stripVoiceTag } from '../src/chatRunner.js';

describe('stripVoiceTag', () => {
  it('removes the tags the host writes', () => {
    expect(stripVoiceTag('[voice • mobile] turn on the lights')).toBe('turn on the lights');
    expect(stripVoiceTag('[voice hand-off • desktop] carry on')).toBe('carry on');
    expect(stripVoiceTag('[voice • device:kitchen] hello')).toBe('hello');
  });

  it('leaves a typed message that merely starts with a bracket beginning "voice"', () => {
    expect(stripVoiceTag('[voiceover] hello')).toBe('[voiceover] hello');
    expect(stripVoiceTag('[voicemail from Bob] call back')).toBe('[voicemail from Bob] call back');
  });
});
