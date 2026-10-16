import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmRefusal, spawnClaudeInGroup } from '../src/claudeSpawn.js';

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

// A stand-in for claude: prints its grandchild's pid, then sleeps.
const script = `const c=require('child_process').spawn('sleep',['300'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`;

async function start(signal: AbortSignal) {
  const p = spawnClaudeInGroup({
    command: process.execPath,
    args: ['-e', script],
    env: process.env,
    signal,
  });
  const pid = await new Promise<number>((res) =>
    p.stdout.once('data', (d) => res(Number(String(d).trim()))),
  );
  return { p, pid };
}

describe('spawnClaudeInGroup', () => {
  it('kill() takes the grandchild with it', async () => {
    const { p, pid } = await start(new AbortController().signal);
    expect(alive(pid)).toBe(true);
    p.kill('SIGTERM');
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  });

  it('abort signal reaps the grandchild', async () => {
    const ac = new AbortController();
    const { pid } = await start(ac.signal);
    ac.abort();
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  });

  it('grandchild left running when claude exits on its own is swept', async () => {
    const quick = `const c=require('child_process').spawn('sleep',['300'],{stdio:'ignore'});console.log(c.pid);setTimeout(()=>process.exit(0),200)`;
    const p = spawnClaudeInGroup({
      command: process.execPath,
      args: ['-e', quick],
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

describe('confirmRefusal', () => {
  const errno = (code: string) => Object.assign(new Error(code), { code });
  afterEach(() => vi.restoreAllMocks());

  it('a group that was only dying is not reported', async () => {
    vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw errno('ESRCH');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    confirmRefusal(-123, 'SIGKILL', [0]);
    await new Promise((r) => setTimeout(r, 20));
    expect(err).not.toHaveBeenCalled();
  });

  it('a refusal that persists is reported', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errno('EPERM');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    confirmRefusal(-123, 'SIGKILL', [0, 0]);
    await new Promise((r) => setTimeout(r, 20));
    expect(process.kill).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('group 123: SIGKILL refused (EPERM)'));
  });

  it('a refusal that persists is also passed to the chat it belongs to', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errno('EPERM');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const told = vi.fn();
    confirmRefusal(-123, 'SIGKILL', [0, 0], told);
    await new Promise((r) => setTimeout(r, 20));
    expect(told).toHaveBeenCalledTimes(1);
    expect(told).toHaveBeenCalledWith(
      expect.stringContaining('group 123: SIGKILL refused (EPERM)'),
    );
  });

  it('a group that was only dying tells the chat nothing', async () => {
    vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw errno('ESRCH');
    });
    const told = vi.fn();
    confirmRefusal(-123, 'SIGKILL', [0], told);
    await new Promise((r) => setTimeout(r, 20));
    expect(told).not.toHaveBeenCalled();
  });
});

describe('spawnClaudeInGroup, signalling a group that is already dying', () => {
  // On macOS the second kill lands on a group the kernel has not reaped yet and
  // comes back EPERM; it used to be thrown and crashed the host.
  it('does not throw, and the grandchild still goes', async () => {
    const { p, pid } = await start(new AbortController().signal);
    p.kill('SIGKILL');
    expect(() => p.kill('SIGKILL')).not.toThrow();
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  });
});
