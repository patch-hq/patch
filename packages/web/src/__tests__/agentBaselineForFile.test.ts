import { describe, it, expect, beforeEach } from 'vitest';
import { agentBaselineForFile } from '../components/EditorRail';
import { useChatStore } from '../stores/chatStore';

function edit(filePath: string, oldString: string, newString: string): void {
  useChatStore.setState((s) => ({
    timelines: {
      ...s.timelines,
      c1: [
        {
          kind: 'tool_call',
          seq: 1,
          tool: 'Edit',
          toolArgs: { file_path: filePath, old_string: oldString, new_string: newString },
        } as never,
      ],
    },
  }));
}

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('agentBaselineForFile', () => {
  it('rebuilds the pre-edit file for the file the agent edited', () => {
    edit('/proj/src/index.ts', 'old', 'new');
    expect(agentBaselineForFile('c1', 'src/index.ts', 'a new b')).toEqual({
      kind: 'reconstructed',
      original: 'a old b',
    });
  });

  it('does not match a path that is only the tail of another file name', () => {
    edit('/proj/src/index.ts', 'old', 'new');
    expect(agentBaselineForFile('c1', 'dex.ts', 'a new b')).toEqual({ kind: 'untouched' });
  });

  it('cannot place an edit that deleted text, rather than appending the old text at the end', () => {
    edit('/proj/a.ts', 'REMOVED LINE\n', '');
    expect(agentBaselineForFile('c1', 'a.ts', 'line1\nline2\n')).toEqual({
      kind: 'unreconstructable',
    });
  });
});
