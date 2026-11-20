import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentHeldSession,
  createClaudeSessionProbe,
  encodeFolder,
  persistedUserContent,
} from '../src/history.js';

describe('session probe', () => {
  it('hasSession() reflects whether Claude Code has written the session yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
    const folder = '/work/proj';
    const dir = join(root, encodeFolder(folder));
    mkdirSync(dir, { recursive: true });
    const reader = createClaudeSessionProbe({ claudeProjectsRoot: root });
    expect(reader.hasSession({ folder, sessionId: 'not-yet' })).toBe(false);
    writeFileSync(join(dir, 'now-here.jsonl'), '', 'utf8');
    expect(reader.hasSession({ folder, sessionId: 'now-here' })).toBe(true);
  });

  it("hasSession() counts a non-empty conversation file in the chat's own dir, never a retired native copy", () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
    const chatDir = mkdtempSync(join(tmpdir(), 'patch-chat-'));
    const folder = '/work/proj';
    const reader = createClaudeSessionProbe({ claudeProjectsRoot: root });
    const own = join(chatDir, 'claude', 'projects', encodeFolder(folder));
    mkdirSync(own, { recursive: true });
    mkdirSync(join(chatDir, 'native', 'claude'), { recursive: true });
    writeFileSync(join(own, 'empty.jsonl'), '', 'utf8');
    expect(reader.hasSession({ folder, sessionId: 'empty', chatDir })).toBe(false);
    writeFileSync(join(own, 'live.jsonl'), '{"type":"user"}\n', 'utf8');
    expect(reader.hasSession({ folder, sessionId: 'live', chatDir })).toBe(true);
    expect(reader.hasSession({ folder, sessionId: 'live' })).toBe(false);
    writeFileSync(join(chatDir, 'native', 'claude', 'old.jsonl'), '{"type":"user"}\n', 'utf8');
    expect(reader.hasSession({ folder, sessionId: 'old', chatDir })).toBe(false);
  });

  it('createClaudeSessionProbe() defaults to ~/.claude/projects when no override is given', () => {
    // No claudeProjectsRoot passed — exercises defaultClaudeProjectsRoot().
    // We don't touch the real ~/.claude/projects; hasSession() only stats a
    // path and returns false for a session that doesn't exist.
    const reader = createClaudeSessionProbe();
    expect(reader.hasSession({ folder: '/nonexistent-xyz', sessionId: 'nope' })).toBe(false);
  });

  it("encodeFolder matches the SDK's projects-dir name: every non-alphanumeric is '-', long paths truncate + hash", () => {
    expect(encodeFolder('/home/u/my_app')).toBe('-home-u-my-app');
    expect(encodeFolder('/home/u/.claude/worktrees/x')).toBe('-home-u--claude-worktrees-x');
    expect(encodeFolder('/a b/c@d')).toBe('-a-b-c-d');
    // Over 200 chars: the SDK keeps the first 200 and appends a base-36 hash
    // of the ORIGINAL path (value computed with the SDK's own function).
    const long = '/home/u/' + 'a'.repeat(250);
    expect(encodeFolder(long)).toBe(`-home-u-${'a'.repeat(192)}-bkw3mj`);
  });

  it('an ACP agent keeps its own session: a named one is always the agent’s to resume', () => {
    expect(agentHeldSession.hasSession({ folder: '/w', sessionId: 'gemini-abc' })).toBe(true);
    expect(agentHeldSession.hasSession({ folder: '/w', sessionId: '' })).toBe(false);
  });
});

describe('persistedUserContent — the user turn as the record shows it', () => {
  const cases: [label: string, prompt: string, expected: string][] = [
    ['already canonical', '/plant nettle', '/plant nettle'],
    ['no args at all', '/portfolio-cleanup', '/portfolio-cleanup'],
    ['colon-namespaced command', '/plugin:skill do the thing', '/plugin:skill do the thing'],
    [
      'body on its own line, trailing whitespace from an empty mustache field',
      '/ha-update\n\nHome Automation Todoist event\n\nDescription on the task (if any): ',
      '/ha-update Home Automation Todoist event\n\nDescription on the task (if any):',
    ],
    ['sloppy trailing whitespace', '/dumb   lots   of   space  ', '/dumb lots   of   space'],
    ['trailing newline', '/goal finish the app\n', '/goal finish the app'],
    [
      'an absolute path, not a command',
      '/srv/patch/CONTEXT.md   needs a note  ',
      '/srv/patch/CONTEXT.md   needs a note  ',
    ],
    ['a plain sentence', 'turn the lights off  ', 'turn the lights off  '],
    ['a slash mid-message is plain text', 'please run /plant now', 'please run /plant now'],
  ];
  for (const [label, prompt, expected] of cases) {
    it(label, () => {
      expect(persistedUserContent(prompt)).toBe(expected);
    });
  }

  it('strips a leading broadcast system-reminder before normalising the command', () => {
    const prompt =
      '<system-reminder>\nRecent broadcasts\n</system-reminder>\n\n/goal   finish the app  ';
    expect(persistedUserContent(prompt)).toBe('/goal finish the app');
  });

  it('drops a command wrapper with no recoverable name', () => {
    expect(
      persistedUserContent('<command-name></command-name>\n<command-args>x</command-args>'),
    ).toBe(null);
  });
});
