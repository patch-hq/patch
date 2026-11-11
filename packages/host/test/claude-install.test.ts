// Provisioning Claude Code on a host that has none (spec/02 § Agent backends).

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { spawn } from 'node:child_process';
import { installClaudeCode, installFailure } from '../src/claudeInstall.js';
import { claudeBackendEntry } from '../src/host.js';

function fakeSpawn(
  script: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }) => void,
) {
  const calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
  const impl = ((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    calls.push({ cmd, args, env: opts.env });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    setImmediate(() => script(child));
    return child;
  }) as unknown as typeof spawn;
  return { impl, calls };
}

describe('installClaudeCode', () => {
  it('runs Claude Code’s own installer, fetched whole before it runs', async () => {
    const { impl, calls } = fakeSpawn((c) => {
      c.stdout.write('Claude Code successfully installed!\n');
      c.emit('close', 0);
    });
    const r = await installClaudeCode({ home: '/home/x', spawnImpl: impl });
    expect(r.ok).toBe(true);
    expect(calls[0]!.cmd).toBe('/bin/sh');
    expect(calls[0]!.args[1]).toContain('script=$(curl -fsSL');
    expect(calls[0]!.args[1]).toContain('| bash');
    expect(calls[0]!.env['CLAUDE_INSTALL_SCRIPT_URL']).toBe('https://claude.ai/install.sh');
    expect(calls[0]!.env['HOME']).toBe('/home/x');
  });

  it('reports a failed install with the installer’s own last lines', async () => {
    const { impl } = fakeSpawn((c) => {
      c.stderr.write('curl: (6) Could not resolve host: claude.ai\n');
      c.emit('close', 6);
    });
    const r = await installClaudeCode({ home: '/h', spawnImpl: impl });
    expect(r.ok).toBe(false);
    expect(installFailure(r)).toBe(
      'Installing Claude Code failed (6): curl: (6) Could not resolve host: claude.ai',
    );
  });

  it('says so when the installer cannot start at all', async () => {
    const { impl } = fakeSpawn((c) => c.emit('error', new Error('spawn /bin/sh ENOENT')));
    const r = await installClaudeCode({ home: '/h', spawnImpl: impl });
    expect(r).toMatchObject({ ok: false, exitCode: null });
    expect(installFailure(r)).toContain('did not run');
  });
});

describe('claudeBackendEntry', () => {
  const base = { version: null, credentialOk: true };
  it('reports an install in progress, and a failed one with its reason', () => {
    expect(
      claudeBackendEntry({ ...base, executableResolved: false, provision: { state: 'installing' } })
        .state,
    ).toBe('installing');
    const failed = claudeBackendEntry({
      ...base,
      executableResolved: false,
      provision: { state: 'failed', error: 'no network' },
    });
    expect(failed).toMatchObject({ state: 'failed', error: 'no network' });
  });
  it('is absent with no executable, and present or logged out once there is one', () => {
    expect(claudeBackendEntry({ ...base, executableResolved: false }).state).toBe('absent');
    expect(
      claudeBackendEntry({ ...base, executableResolved: true, provision: { state: 'present' } })
        .state,
    ).toBe('present');
    expect(
      claudeBackendEntry({ version: null, credentialOk: false, executableResolved: true }).state,
    ).toBe('logged-out');
  });
});
