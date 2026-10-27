// The claude CLI compacts a 200K+ conversation that sits idle ~54 minutes
// ("idle compaction", on by default). Patch chats idle between turns all the
// time, so a 540k chat was squashed to 34k with most of the window unused.
// Patch must keep the CLI's own window-fill auto-compaction but never the
// idle one.
import { describe, it, expect } from 'vitest';
import { buildSdkEnv } from '../src/sdkBackend.js';

const base = { prompt: 'x', cwd: '/tmp', abortController: new AbortController() };

describe('buildSdkEnv — idle compaction', () => {
  it('raises the idle-compaction floor above any real context window', () => {
    const { env } = buildSdkEnv(base);
    expect(Number(env['CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'])).toBeGreaterThan(10_000_000);
  });

  it('does not inherit a sleep-compact opt-in from the host process', () => {
    process.env['CLAUDE_CODE_SLEEP_COMPACT'] = '1';
    process.env['CLAUDE_CODE_SLEEP_COMPACT_AFTER_MS'] = '1000';
    try {
      const { env } = buildSdkEnv(base);
      expect(env['CLAUDE_CODE_SLEEP_COMPACT']).toBeUndefined();
      expect(env['CLAUDE_CODE_SLEEP_COMPACT_AFTER_MS']).toBeUndefined();
    } finally {
      delete process.env['CLAUDE_CODE_SLEEP_COMPACT'];
      delete process.env['CLAUDE_CODE_SLEEP_COMPACT_AFTER_MS'];
    }
  });

  it('leaves normal auto-compaction alone', () => {
    const { env } = buildSdkEnv(base);
    expect(env['DISABLE_AUTO_COMPACT']).toBeUndefined();
    expect(env['CLAUDE_CODE_AUTO_COMPACT_WINDOW']).toBeUndefined();
  });
});
