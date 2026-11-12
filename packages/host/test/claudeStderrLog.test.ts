import { describe, expect, it } from 'vitest';
import { closeSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnClaudeInGroup } from '../src/claudeSpawn.js';
import {
  CLAUDE_STDERR_LOG,
  claudeStderrLogPath,
  openClaudeStderrLog,
} from '../src/claudeStderrLog.js';

describe('claude stderr log', () => {
  it('lives in the chat config dir', () => {
    expect(claudeStderrLogPath({ CLAUDE_CONFIG_DIR: '/x/chats/c1/claude' })).toBe(
      join('/x/chats/c1/claude', CLAUDE_STDERR_LOG),
    );
  });

  it('rotates past the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stderrlog-'));
    const path = join(dir, CLAUDE_STDERR_LOG);
    writeFileSync(path, 'x'.repeat(100));
    closeSync(openClaudeStderrLog(path, 10));
    expect(readFileSync(`${path}.1`, 'utf8')).toHaveLength(100);
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('keeps a spawned process stderr and its exit status', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'chatcfg-'));
    const realDir = mkdtempSync(join(tmpdir(), 'realcfg-'));
    process.env['CLAUDE_CONFIG_DIR'] = realDir;
    const ac = new AbortController();
    const child = spawnClaudeInGroup({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("boom on stderr\\n"); process.exit(3)'],
      cwd: configDir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      signal: ac.signal,
    });
    await new Promise<void>((r) => child.once('exit', () => r()));
    await new Promise((r) => setTimeout(r, 50));
    const path = join(configDir, CLAUDE_STDERR_LOG);
    expect(existsSync(path)).toBe(true);
    const log = readFileSync(path, 'utf8');
    expect(log).toMatch(/spawned claude pid \d+/);
    expect(log).toContain('boom on stderr');
    expect(log).toMatch(/exited code=3 signal=null/);
  });
});
