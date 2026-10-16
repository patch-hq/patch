import { describe, it, expect } from 'vitest';
import { diffFromToolCall, unifiedLines } from '../src/components/UnifiedDiff';

describe('diffFromToolCall — maps Edit/Write/MultiEdit tool calls to diff pairs', () => {
  it('extracts old→new from an Edit tool call', () => {
    expect(
      diffFromToolCall('Edit', { old_string: 'two', new_string: 'TWO', file_path: '/x' }),
    ).toEqual([{ oldText: 'two', newText: 'TWO' }]);
  });

  it('treats a Write tool call as an all-added (new file) diff', () => {
    expect(diffFromToolCall('Write', { content: 'hello\nworld' })).toEqual([
      { oldText: '', newText: 'hello\nworld' },
    ]);
  });

  it('concatenates each edit of a MultiEdit', () => {
    expect(
      diffFromToolCall('MultiEdit', {
        edits: [
          { old_string: 'a', new_string: 'A' },
          { old_string: 'b', new_string: 'B' },
        ],
      }),
    ).toEqual([
      { oldText: 'a', newText: 'A' },
      { oldText: 'b', newText: 'B' },
    ]);
  });

  it('is case-insensitive on the tool name (real SDK emits "Edit")', () => {
    expect(diffFromToolCall('edit', { old_string: 'x', new_string: 'y' })).toEqual([
      { oldText: 'x', newText: 'y' },
    ]);
  });

  it('returns null for a non-diff tool (so it renders as a plain collapsible call)', () => {
    expect(diffFromToolCall('Bash', { command: 'ls' })).toBeNull();
    expect(diffFromToolCall('Read', { file_path: '/x' })).toBeNull();
    expect(diffFromToolCall(undefined, {})).toBeNull();
  });

  it('returns null for a MultiEdit with no well-formed edits', () => {
    expect(diffFromToolCall('MultiEdit', { edits: [{ nope: 1 }] })).toBeNull();
  });
});

describe('unifiedLines — a final newline ends the last line, it does not add one', () => {
  it('a written file ending in a newline is its lines, with no blank added line', () => {
    expect(unifiedLines('', 'a\nb\n')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
  });

  it('deleting a file ending in a newline shows only its lines', () => {
    expect(unifiedLines('x\n', '')).toEqual([{ kind: 'del', text: 'x' }]);
  });

  it('an edit inside a text keeps its context and changes one line', () => {
    expect(unifiedLines('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'context', text: 'c' },
    ]);
  });

  it('text with no final newline is unchanged', () => {
    expect(unifiedLines('', 'a\nb')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
  });
});
