import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { StrayProcessTracker } from '../src/strayProcesses.js';

// The real thing: a shell backgrounds `sleep` with nohup and exits, exactly as
// a chat's Bash call does, and the tracker finds the orphan in the live /proc.
describe.skipIf(!existsSync('/proc/self/stat'))('stray processes against the live /proc', () => {
  it('finds a nohup background process, then stops it', async () => {
    const chat = `live-${process.pid}-${Date.now()}`;
    execFileSync('sh', ['-c', 'nohup sleep 31 >/dev/null 2>&1 &'], {
      env: { ...process.env, PATCH_CHAT_ID: chat },
    });
    const tracker = new StrayProcessTracker();
    await new Promise((r) => setTimeout(r, 200));
    const rows = tracker.list(chat);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ running: true });
    expect(rows[0]?.command).toContain('sleep 31');
    expect(tracker.stop(chat, rows[0]!.pid)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(tracker.list(chat)[0]).toMatchObject({ running: false });
  });
});
