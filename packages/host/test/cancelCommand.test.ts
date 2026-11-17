import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  cancelBashCall,
  cancelTargets,
  commandFingerprint,
  findBashShell,
  parsePsRows,
} from '../src/cancelCommand.js';

const PS = `
  1     0 /sbin/init
 100     1 claude --output-format stream-json
 101   100 node /opt/mcp-server.js
 200   100 /bin/bash -c -l source /tmp/snap.sh && eval 'pnpm test --run' < /dev/null && pwd -P >| /tmp/cwd
 201   200 node pnpm test --run
 202   201 node vitest
 300   100 /bin/bash -c -l source /tmp/snap.sh && eval 'sleep 500' < /dev/null && pwd -P >| /tmp/cwd2
 301   300 sleep 500
 400   202 /bin/bash -c echo nested
`;

describe('cancel one Bash call', () => {
  const rows = parsePsRows(PS);

  it('finds the shell of the call by its command, not claude or the MCP server', () => {
    expect(findBashShell(rows, 100, 'pnpm test --run')).toBe(200);
    expect(findBashShell(rows, 100, 'sleep 500')).toBe(300);
  });

  it('never takes a shell the command itself started for the call', () => {
    expect(findBashShell(rows, 100, 'echo nested')).toBeNull();
  });

  it('is null when no call matches, rather than guessing', () => {
    expect(findBashShell(rows, 100, 'git status')).toBeNull();
  });

  it('is null when a command cannot be told apart from a sibling', () => {
    expect(findBashShell(rows, 100, '')).toBeNull();
  });

  it('signals the descendants of the call, leaving its shell and claude alone', () => {
    expect(cancelTargets(rows, 200).sort()).toEqual([201, 202, 400]);
    expect(cancelTargets(rows, 300)).toEqual([301]);
  });

  it('signals the shell itself when the command started nothing', () => {
    expect(cancelTargets(rows, 400)).toEqual([400]);
  });

  it('fingerprints past the quoting around the command', () => {
    expect(commandFingerprint("\n  echo 'hi' && ls")).toBe('echo');
  });
});

describe('cancelBashCall (real processes)', () => {
  it('interrupts the command but not this process', async () => {
    const marker = `cancel-test-${process.pid}-${Date.now()}`;
    const shell = spawn('/bin/bash', ['-c', `eval 'sleep 30 # ${marker}' && true`], {
      stdio: 'ignore',
    });
    const exited = new Promise<void>((r) => shell.once('exit', () => r()));
    await new Promise((r) => setTimeout(r, 300));
    const pids = await cancelBashCall(process.pid, `sleep 30 # ${marker}`);
    expect(pids.length).toBeGreaterThan(0);
    expect(pids).not.toContain(process.pid);
    await exited;
    expect(shell.signalCode !== null || shell.exitCode !== null).toBe(true);
  });

  it('rejects when nothing matches', async () => {
    await expect(cancelBashCall(process.pid, 'no such command anywhere')).rejects.toThrow(
      /no running Bash call/,
    );
  });
});
