// Host self-update (spec/02 § Installation, spec/11 § Host installation).
//
// The guarantees worth testing are the refusals. Until this existed nothing
// consumed the manifest's `signingPublicKey`, so signing every artifact bought
// nothing — an attacker who could serve bytes could serve any bytes.

import { describe, it, expect, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  checkForUpdate,
  verifyArtifactSignature,
  compareVersions,
  createAutoUpdateSettle,
} from '../src/selfUpdate.js';

/** Sign a hex digest exactly as scripts/build-host.mjs does. */
function signDigest(digestHex: string): { sig: string; publicKeyB64Url: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const sig = cryptoSign(null, Buffer.from(digestHex, 'hex'), privateKey);
  return {
    sig: sig.toString('base64url'),
    publicKeyB64Url: Buffer.from(raw).toString('base64url'),
  };
}

describe('artifact signature verification', () => {
  const digest = createHash('sha256').update('the artifact bytes').digest('hex');

  it('accepts a signature made by the project signing key', () => {
    const { sig, publicKeyB64Url } = signDigest(digest);
    expect(
      verifyArtifactSignature({
        sha256Hex: digest,
        signatureB64Url: sig,
        publicKeyB64Url,
      }),
    ).toBe(true);
  });

  it('rejects a signature over DIFFERENT bytes', () => {
    const { sig, publicKeyB64Url } = signDigest(digest);
    const other = createHash('sha256').update('substituted bytes').digest('hex');
    expect(
      verifyArtifactSignature({ sha256Hex: other, signatureB64Url: sig, publicKeyB64Url }),
    ).toBe(false);
  });

  it('rejects a signature from a DIFFERENT key', () => {
    const { sig } = signDigest(digest);
    const { publicKeyB64Url: attacker } = signDigest(digest);
    expect(
      verifyArtifactSignature({
        sha256Hex: digest,
        signatureB64Url: sig,
        publicKeyB64Url: attacker,
      }),
    ).toBe(false);
  });

  it('rejects a malformed key or signature rather than throwing', () => {
    expect(
      verifyArtifactSignature({
        sha256Hex: digest,
        signatureB64Url: 'not-a-signature',
        publicKeyB64Url: 'not-a-key',
      }),
    ).toBe(false);
  });
});

describe('checkForUpdate', () => {
  const manifest = {
    version: '0.2.0',
    gitSha: 'abc',
    builtAt: '2026-08-05T00:00:00.000Z',
    signingPublicKey: 'k',
    artifacts: [{ target: 'darwin-arm64', file: 'a.tar.gz', bytes: 1, sha256: 'd', sig: 's' }],
  };
  const fetchOk = (async () =>
    new Response(JSON.stringify(manifest), { status: 200 })) as unknown as typeof fetch;

  it('reports an update when the published build is newer', async () => {
    const res = await checkForUpdate({
      serverUrl: 'http://s',
      currentVersion: '0.1.0',
      target: 'darwin-arm64',
      fetchImpl: fetchOk,
    });
    expect(res).toMatchObject({ available: true, version: '0.2.0' });
  });

  it('does not report an update when the running build is the same or newer', async () => {
    for (const current of ['0.2.0', '0.3.0']) {
      const res = await checkForUpdate({
        serverUrl: 'http://s',
        currentVersion: current,
        target: 'darwin-arm64',
        fetchImpl: fetchOk,
      });
      expect(res.available).toBe(false);
      expect(res.reason).toContain('not newer');
    }
  });

  it('says WHY when this host has no artifact for its platform', async () => {
    const res = await checkForUpdate({
      serverUrl: 'http://s',
      currentVersion: '0.1.0',
      target: 'linux-arm64',
      fetchImpl: fetchOk,
    });
    expect(res.available).toBe(false);
    expect(res.reason).toContain('linux-arm64');
  });

  it('a host run from source has no update target and says so', async () => {
    const res = await checkForUpdate({
      serverUrl: 'http://s',
      currentVersion: '0.1.0',
      target: undefined,
      fetchImpl: fetchOk,
    });
    expect(res.available).toBe(false);
    expect(res.reason).toContain('not running from a built artifact');
  });

  it('an unreachable channel is reported as unknown, never as "no update"', async () => {
    const res = await checkForUpdate({
      serverUrl: 'http://s',
      currentVersion: '0.1.0',
      target: 'darwin-arm64',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(res.available).toBe(false);
    expect(res.reason).toContain('could not reach the update channel');
  });
});

describe('compareVersions', () => {
  it('orders builds numerically, not lexically', () => {
    expect(compareVersions('0.1.375', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.2', '0.1.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('returns null for a version it cannot parse rather than guessing', () => {
    expect(compareVersions('nightly', '1.0.0')).toBeNull();
  });
});

// Applying an update is the one operation that kills the process performing it:
// the installer restarts the service, and this IS that service. Judging success
// by the installer's exit code therefore reports a working update as a failure —
// which sends someone to run it again, straight into ETXTBSY copying over the
// binaries now running. Judge by what is on disk.
describe('applyUpdate outcome', () => {
  it('redacts the internal token from anything it reports', async () => {
    const { applyUpdate } = await import('../src/selfUpdate.js');
    const secret = 'super-secret-internal-token';
    const res = await applyUpdate({
      serverUrl: 'http://s',
      internalToken: secret,
      currentVersion: '0.1.0',
      target: 'linux-x64',
      patchHome: '/nonexistent',
      logger: { info() {}, warn() {}, error() {} } as never,
      // Fails at the manifest fetch; the message must still never carry the token.
      fetchImpl: (async () => {
        throw new Error(`connect failed using --internal-token ${secret}`);
      }) as unknown as typeof fetch,
    });
    expect(res.applied).toBe(false);
    expect(res.message).not.toContain(secret);
  });
});

// launchd's bootout kills every process in the job's group, and the installer
// boots out the job that started it — so it must not share that group.
describe('runDetached: the installer outlives the service it restarts', () => {
  it('starts the installer in a process group of its own, writing to the given file', async () => {
    const { runDetached } = await import('../src/selfUpdate.js');
    const { mkdtempSync, openSync, closeSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const log = join(mkdtempSync(join(tmpdir(), 'self-update-')), 'out.log');
    const fd = openSync(log, 'a');
    await runDetached('/bin/sh', ['-c', 'ps -o pgid= -p $$'], fd);
    closeSync(fd);
    const childGroup = readFileSync(log, 'utf8').trim();
    const ourGroup = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      encoding: 'utf8',
    }).trim();
    expect(childGroup).toMatch(/^\d+$/);
    expect(childGroup).not.toBe(ourGroup);
  });

  it('rejects when the installer fails', async () => {
    const { runDetached } = await import('../src/selfUpdate.js');
    const { openSync } = await import('node:fs');
    await expect(
      runDetached('/bin/sh', ['-c', 'exit 3'], openSync('/dev/null', 'a')),
    ).rejects.toThrow('installer exited 3');
  });
});

// The wire event and the local control command are two independent doors onto
// the same action, and clicking a button that gave no feedback is exactly the
// kind of thing that gets clicked twice — reproduces 2026-09-28 (the user's Mac),
// where the second run's own installer raced the first's.
describe('createUpdateGate: concurrent callers join one attempt', () => {
  it('a second call while the first is in flight gets the SAME promise, not a second run', async () => {
    const { createUpdateGate } = await import('../src/selfUpdate.js');
    let calls = 0;
    let resolveFirst!: (v: { applied: boolean; message: string }) => void;
    const apply = vi.fn(
      () =>
        new Promise<{ applied: boolean; message: string }>((resolve) => {
          calls += 1;
          resolveFirst = resolve;
        }),
    );
    const gated = createUpdateGate(apply as never);
    const a = gated({} as never);
    const b = gated({} as never);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    resolveFirst({ applied: true, message: 'updated' });
    await expect(a).resolves.toEqual({ applied: true, message: 'updated' });
  });

  it('a call once the first has settled starts a fresh attempt', async () => {
    const { createUpdateGate } = await import('../src/selfUpdate.js');
    const apply = vi
      .fn()
      .mockResolvedValueOnce({ applied: false, message: 'first' })
      .mockResolvedValueOnce({ applied: true, message: 'second' });
    const gated = createUpdateGate(apply as never);
    await expect(gated({} as never)).resolves.toEqual({ applied: false, message: 'first' });
    await expect(gated({} as never)).resolves.toEqual({ applied: true, message: 'second' });
    expect(apply).toHaveBeenCalledTimes(2);
  });
});

// An install never waits for turns: a Claude turn runs under its own runner and
// carries on across the restart (spec/02 § Turns outlive the host). 2026-11-05:
// with jobs firing all night, a hold for idle meant the host never updated.
describe('requestUpdate: turns do not hold an install', () => {
  const logger = { info() {}, warn() {}, error() {} } as never;
  const available = async () => ({ available: true, version: '0.2.0', reason: 'newer' });

  it('applies at once and reports the apply, whatever is running', async () => {
    const { requestUpdate } = await import('../src/selfUpdate.js');
    const apply = vi.fn().mockResolvedValue({ applied: true, message: 'updated' });
    const res = await requestUpdate({ check: available, apply, logger });
    expect(res).toEqual({ applied: true, message: 'updated' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('applyUpdate goes from a verified artifact straight to the installer', async () => {
    const { applyUpdate } = await import('../src/selfUpdate.js');
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'patch-su-test-'));
    try {
      const name = 'patch-host-0.2.0-linux-x64';
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'install'), '#!/bin/sh\n');
      execFileSync('tar', ['-czf', join(dir, `${name}.tar.gz`), '-C', dir, name]);
      const bytes = readFileSync(join(dir, `${name}.tar.gz`));
      const digest = createHash('sha256').update(bytes).digest('hex');
      const { sig, publicKeyB64Url } = signDigest(digest);
      const manifest = {
        version: '0.2.0',
        signingPublicKey: publicKeyB64Url,
        artifacts: [{ target: 'linux-x64', file: `${name}.tar.gz`, sha256: digest, sig }],
      };
      const fetchImpl = (async (url: string) =>
        url.endsWith('.json')
          ? new Response(JSON.stringify(manifest))
          : new Response(bytes)) as unknown as typeof fetch;
      const order: string[] = [];
      await applyUpdate({
        serverUrl: 'http://s',
        internalToken: 'secret-internal-token',
        currentVersion: '0.1.0',
        target: 'linux-x64',
        patchHome: join(dir, 'home'),
        logger,
        fetchImpl,
        onInstallStart: (v) => {
          order.push(`start:${v}`);
        },
        runInstaller: async () => {
          order.push('install');
        },
      });
      expect(order).toEqual(['start:0.2.0', 'install']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 2026-10-04/05: a deploy publishes linux-x64 first and darwin-arm64 a minute
// later, so a Mac polling in between saw a newer version with no artifact for
// it and toasted "did not update" on a deploy that was fine.
describe('a newer build with no artifact for this target yet', () => {
  const logger = { info() {}, warn() {}, error() {} } as never;
  const manifest = (artifacts: string[], version = '0.2.0') =>
    (async () =>
      new Response(
        JSON.stringify({
          version,
          artifacts: artifacts.map((target) => ({ target, file: `${target}.tar.gz` })),
        }),
      )) as unknown as typeof fetch;

  it('checkForUpdate flags it as awaiting the artifact, not as a plain refusal', async () => {
    const res = await checkForUpdate({
      serverUrl: 'http://s',
      currentVersion: '0.1.0',
      target: 'darwin-arm64',
      fetchImpl: manifest(['linux-x64']),
    });
    expect(res.available).toBe(false);
    expect(res.awaitingArtifact).toBe(true);
    expect(res.reason).toContain('no artifact for darwin-arm64');
  });

  it('an old manifest with no artifact is NOT awaiting (nothing newer is coming)', async () => {
    const res = await checkForUpdate({
      serverUrl: 'http://s',
      currentVersion: '0.2.0',
      target: 'darwin-arm64',
      fetchImpl: manifest(['linux-x64']),
    });
    expect(res.awaitingArtifact).toBeFalsy();
  });

  const awaiting = async () => ({
    available: false,
    awaitingArtifact: true,
    version: '0.2.0',
    reason: 'the published build has no artifact for darwin-arm64',
  });

  it('requestUpdate answers deferred and quietly applies once the artifact lands', async () => {
    const { requestUpdate, createArtifactWait } = await import('../src/selfUpdate.js');
    const onGiveUp = vi.fn();
    const sleep = vi.fn(async () => undefined);
    const checks = [
      awaiting,
      awaiting,
      async () => ({ available: true, version: '0.2.0', reason: 'newer' }),
    ];
    let n = 0;
    const check = vi.fn(() => checks[Math.min(n++, checks.length - 1)]!());
    const apply = vi.fn().mockResolvedValue({ applied: true, message: 'updated' });
    const wait = createArtifactWait({ windowMs: 300_000, pollMs: 15_000, sleep, onGiveUp });
    const res = await requestUpdate({
      check,
      apply,
      logger,
      artifactWait: wait,
    });
    expect(res.deferred).toBe(true);
    expect(res.applied).toBe(false);
    await wait.settled();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('keeps waiting quietly past the window and applies when the artifact lands', async () => {
    const { requestUpdate, createArtifactWait } = await import('../src/selfUpdate.js');
    const onGiveUp = vi.fn();
    const onPendingChange = vi.fn();
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    let n = 0;
    const check = vi.fn(async () =>
      n++ < 20 ? awaiting() : { available: true, version: '0.2.0', reason: 'newer' },
    );
    const apply = vi.fn().mockResolvedValue({ applied: true, message: 'updated' });
    const wait = createArtifactWait({
      windowMs: 60_000,
      pollMs: 15_000,
      slowPollMs: 120_000,
      sleep,
      onGiveUp,
      onPendingChange,
      now: () => now,
    });
    await requestUpdate({ check, apply, logger, artifactWait: wait });
    await wait.settled();
    expect(now).toBeGreaterThan(60_000);
    expect(sleep).toHaveBeenCalledWith(120_000);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(onPendingChange.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it('still reports a genuine failure once the artifact lands', async () => {
    const { requestUpdate, createArtifactWait } = await import('../src/selfUpdate.js');
    const onGiveUp = vi.fn();
    const checks = [awaiting, async () => ({ available: true, version: '0.2.0', reason: 'newer' })];
    let n = 0;
    const check = vi.fn(() => checks[Math.min(n++, 1)]!());
    const apply = vi.fn().mockResolvedValue({ applied: false, message: 'bad signature' });
    const wait = createArtifactWait({ sleep: async () => undefined, onGiveUp });
    await requestUpdate({ check, apply, logger, artifactWait: wait });
    await wait.settled();
    expect(onGiveUp).toHaveBeenCalledWith('bad signature');
  });

  it('repeat requests join the one wait instead of starting another', async () => {
    const { requestUpdate, createArtifactWait } = await import('../src/selfUpdate.js');
    let release!: () => void;
    const sleep = () => new Promise<void>((r) => (release = r));
    const check = vi.fn(awaiting);
    const wait = createArtifactWait({ windowMs: 60_000, pollMs: 15_000, sleep, onGiveUp: vi.fn() });
    const opts = { check, apply: vi.fn(), logger, artifactWait: wait };
    await requestUpdate(opts);
    await requestUpdate(opts);
    expect(wait.active).toBe(true);
    release();
  });
});

// "Patch sometimes locks up, maybe after an update" (Todoist 6hh3QMg45hVwMxp6).
// Nothing in the update path had a time limit: a fetch that never answered, a
// tar that never exited or an installer that never returned left the attempt
// pending forever, and createUpdateGate joins every later click onto that same
// pending attempt — so one stall disabled updating until the host restarted.
describe('update path: every step is bounded, a stall is reported not awaited', () => {
  const logger = { info() {}, warn() {}, error() {} } as never;
  /** A fetch that never answers on its own — it only ends when its signal aborts. */
  const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;

  it('checkForUpdate gives up on a silent update channel and says it timed out', async () => {
    const res = await checkForUpdate({
      serverUrl: 'http://s',
      currentVersion: '0.1.0',
      target: 'linux-x64',
      fetchImpl: hangingFetch,
      timeoutMs: 50,
    });
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/timed out/i);
  });

  it('applyUpdate stops waiting on a stalled artifact download and reports it', async () => {
    const { applyUpdate } = await import('../src/selfUpdate.js');
    const manifest = {
      version: '0.2.0',
      gitSha: 'x',
      builtAt: 'x',
      signingPublicKey: 'x',
      artifacts: [{ target: 'linux-x64', file: 'p.tar.gz', bytes: 1, sha256: 'x', sig: 'x' }],
    };
    const fetchImpl = ((url: string, init?: { signal?: AbortSignal }) =>
      url.endsWith('host-latest.json')
        ? Promise.resolve(new Response(JSON.stringify(manifest)))
        : (hangingFetch as unknown as (u: string, i?: unknown) => Promise<Response>)(
            url,
            init,
          )) as unknown as typeof fetch;
    const res = await applyUpdate({
      serverUrl: 'http://s',
      internalToken: 'secret-internal-token',
      currentVersion: '0.1.0',
      target: 'linux-x64',
      patchHome: '/nonexistent',
      logger,
      fetchImpl,
      timeoutMs: 50,
    });
    expect(res.applied).toBe(false);
    expect(res.message).toMatch(/timed out/i);
  });

  it('runDetached kills an installer that outlives its time limit and rejects', async () => {
    const { runDetached } = await import('../src/selfUpdate.js');
    const { openSync } = await import('node:fs');
    const started = Date.now();
    await expect(
      runDetached('/bin/sh', ['-c', 'sleep 30'], openSync('/dev/null', 'a'), 100),
    ).rejects.toThrow(/did not finish within/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('describeUpdateRefusal', () => {
  it('turns a missing artifact into plain words with no host id or target', async () => {
    const { describeUpdateRefusal } = await import('../src/selfUpdate.js');
    const text = describeUpdateRefusal('the published build has no artifact for darwin-arm64');
    expect(text).toBe(
      "Update not ready: the new version hasn't finished building for this computer. Try again in a few minutes.",
    );
    expect(text).not.toContain('darwin');
    expect(text).not.toContain('host.update');
  });

  it('leaves other reasons readable, prefixed in plain words', async () => {
    const { describeUpdateRefusal } = await import('../src/selfUpdate.js');
    expect(describeUpdateRefusal('could not reach the update channel: boom')).toBe(
      'Update failed: could not reach the update channel: boom',
    );
  });
});

describe('auto-update settle', () => {
  it('waits for a build to stay the newest before installing it, and restarts the clock on a newer one', () => {
    let t = 0;
    const s = createAutoUpdateSettle({ settleMs: 1000, now: () => t });
    expect(s.settled('1.0.1')).toBe(false);
    t = 999;
    expect(s.settled('1.0.1')).toBe(false);
    t = 1000;
    expect(s.settled('1.0.1')).toBe(true);
    t = 1500;
    expect(s.settled('1.0.2')).toBe(false);
    t = 2499;
    expect(s.settled('1.0.2')).toBe(false);
    t = 2500;
    expect(s.settled('1.0.2')).toBe(true);
  });
});
