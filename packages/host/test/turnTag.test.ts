import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { killTagged, newTurnTag, TURN_TAG_ENV } from '../src/turnTag.js';
import { spawnClaudeInGroup } from '../src/claudeSpawn.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (f: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

describe('killTagged', () => {
  it('kills a process in another session that carries the tag, and only that', async () => {
    const tag = newTurnTag();
    const mk = (env: Record<string, string>) =>
      spawn('sleep', ['300'], { env: { ...process.env, ...env }, detached: true, stdio: 'ignore' });
    const tagged = mk({ [TURN_TAG_ENV]: tag });
    const other = mk({ [TURN_TAG_ENV]: newTurnTag() });
    try {
      const killed = killTagged(tag);
      expect(killed).toEqual([tagged.pid]);
      await until(() => !alive(tagged.pid!));
      expect(alive(tagged.pid!)).toBe(false);
      expect(alive(other.pid!)).toBe(true);
    } finally {
      other.kill('SIGKILL');
      tagged.kill('SIGKILL');
    }
  });
});

describe('spawnClaudeInGroup tag sweep', () => {
  it('reaps a grandchild that setsid-ed out of the group when claude exits', async () => {
    // Stand-in claude: starts a session-leader grandchild, prints its pid, exits.
    const script = `const c=require('child_process').spawn('sleep',['300'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid);setTimeout(()=>process.exit(0),200)`;
    const p = spawnClaudeInGroup({
      command: process.execPath,
      args: ['-e', script],
      env: process.env,
      signal: new AbortController().signal,
    });
    const pid = await new Promise<number>((res) =>
      p.stdout.once('data', (d) => res(Number(String(d).trim()))),
    );
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  });
});
