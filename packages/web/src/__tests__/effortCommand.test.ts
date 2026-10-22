// Unit tests for the /effort built-in slash command — parsing
// (spec/04-chats-and-folders.md § Effort).

import { describe, it, expect } from 'vitest';
import { parseEffortCommand } from '../lib/effortCommand.js';

describe('parseEffortCommand', () => {
  it('recognises `/effort <level>` and returns the matched level', () => {
    expect(parseEffortCommand('/effort high')).toEqual({
      isEffort: true,
      effort: 'high',
      unknown: null,
    });
  });

  it('is case-insensitive on both the command word and the level', () => {
    expect(parseEffortCommand('/EFFORT Max')).toEqual({
      isEffort: true,
      effort: 'max',
      unknown: null,
    });
  });

  it('treats a bare `/effort` as a clear, unlike `/model`', () => {
    expect(parseEffortCommand('/effort')).toEqual({ isEffort: true, effort: null, unknown: null });
    expect(parseEffortCommand('/effort   ')).toEqual({
      isEffort: true,
      effort: null,
      unknown: null,
    });
  });

  it('trims surrounding whitespace around the level', () => {
    expect(parseEffortCommand('  /effort   low  ')).toEqual({
      isEffort: true,
      effort: 'low',
      unknown: null,
    });
  });

  it('carries unrecognised text as `unknown` rather than treating it as a clear', () => {
    expect(parseEffortCommand('/effort extreme')).toEqual({
      isEffort: true,
      effort: null,
      unknown: 'extreme',
    });
  });

  it('does NOT match a normal message or a different slash command', () => {
    expect(parseEffortCommand('no effort today')).toEqual({
      isEffort: false,
      effort: null,
      unknown: null,
    });
    expect(parseEffortCommand('/effortless')).toEqual({
      isEffort: false,
      effort: null,
      unknown: null,
    });
    expect(parseEffortCommand('/model opus')).toEqual({
      isEffort: false,
      effort: null,
      unknown: null,
    });
  });
});
