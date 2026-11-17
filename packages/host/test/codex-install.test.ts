// The pinned Codex runtime installs without npm (spec/02 § Agent backends): a
// computer with nothing installed has no npm, and ChatGPT sign-in runs on Codex.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexLauncher, codexTarget, installCodexFromRegistry } from '../src/codexInstall.js';

const sri = (b: Buffer): string => `sha512-${createHash('sha512').update(b).digest('base64')}`;

function fakeRegistry(tarballs: Record<string, Buffer>, tamper?: string) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    const meta = /^https:\/\/r\.test\/@openai\/codex\/(.+)$/.exec(url);
    if (meta) {
      const v = meta[1]!;
      const body = tarballs[v];
      if (!body) return new Response('not found', { status: 404 });
      return Response.json({
        dist: {
          tarball: `https://r.test/t/${v}.tgz`,
          integrity: sri(tamper === v ? Buffer.from('x') : body),
        },
      });
    }
    const t = /\/t\/(.+)\.tgz$/.exec(url);
    if (t && tarballs[t[1]!]) return new Response(tarballs[t[1]!]);
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

describe('installCodexFromRegistry', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lays down the npm-shaped runtime from both tarballs, checked against their integrity', async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-codex-reg-'));
    const unpacked: Array<{ file: string; dest: string }> = [];
    const { fetchImpl } = fakeRegistry({
      '1.2.3': Buffer.from('launcher'),
      '1.2.3-darwin-arm64': Buffer.from('native'),
    });
    await installCodexFromRegistry(join(dir, 'rt'), '1.2.3', {
      fetchImpl,
      registry: 'https://r.test',
      platform: 'darwin',
      arch: 'arm64',
      untar: async (file, dest) => {
        unpacked.push({ file: readFileSync(file, 'utf8'), dest });
      },
    });
    expect(unpacked.map((u) => u.file)).toEqual(['launcher', 'native']);
    expect(unpacked[0]!.dest).toBe(join(dir, 'rt/node_modules/@openai/codex'));
    expect(unpacked[1]!.dest).toBe(join(dir, 'rt/node_modules/@openai/codex-darwin-arm64'));
    const launcher = readFileSync(join(dir, 'rt/node_modules/.bin/codex'), 'utf8');
    expect(launcher).toContain('vendor/aarch64-apple-darwin/bin/codex');
    expect(launcher).not.toMatch(/\bnode\b(?!_modules)/);
  });

  it('refuses a tarball that does not match the registry', async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-codex-reg-'));
    const { fetchImpl } = fakeRegistry(
      { '1.2.3': Buffer.from('a'), '1.2.3-linux-x64': Buffer.from('b') },
      '1.2.3-linux-x64',
    );
    await expect(
      installCodexFromRegistry(join(dir, 'rt'), '1.2.3', {
        fetchImpl,
        registry: 'https://r.test',
        platform: 'linux',
        arch: 'x64',
        untar: async () => undefined,
      }),
    ).rejects.toThrow(/integrity/);
    expect(existsSync(join(dir, 'rt/node_modules/.bin/codex'))).toBe(false);
  });

  it('names a platform Codex does not ship for', () => {
    expect(() => codexTarget('win32', 'x64')).toThrow(/win32-x64/);
    expect(codexTarget('linux', 'arm64').triple).toBe('aarch64-unknown-linux-musl');
  });

  it('the launcher runs the binary with arguments intact and the managed env set', () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-codex-launch-'));
    const root = join(dir, "it's");
    const bin = join(root, 'node_modules/@openai/codex-linux-x64/vendor/t/bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\necho "$CODEX_MANAGED_BY_NPM|$1|$2"\n', {
      mode: 0o755,
    });
    const launcher = join(dir, 'codex');
    writeFileSync(launcher, codexLauncher(root, 't', 'linux-x64'), { mode: 0o755 });
    expect(execFileSync(launcher, ['a b', 'c'], { encoding: 'utf8' }).trim()).toBe('1|a b|c');
  });
});

// The real registry, the real tarball, the real binary — with no npm and no
// node on PATH. Opt-in: it downloads ~120 MB.
describe.runIf(process.env['PATCH_CODEX_REGISTRY_LIVE'] === '1')('live registry install', () => {
  it('installs the pinned Codex and it runs', async () => {
    const { CODEX_VERSION } = await import('../src/codexRuntime.js');
    const root = mkdtempSync(join(tmpdir(), 'patch-codex-live-'));
    try {
      await installCodexFromRegistry(root, CODEX_VERSION);
      const out = execFileSync(join(root, 'node_modules/.bin/codex'), ['--version'], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: root },
      });
      expect(out).toContain(CODEX_VERSION);
      // The runtime reads its version from the launcher package, as after npm.
      const { CodexRuntime } = await import('../src/codexRuntime.js');
      expect(new CodexRuntime(root).version).toBe(CODEX_VERSION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
});
