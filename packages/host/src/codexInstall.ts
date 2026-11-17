// Installing the pinned Codex runtime without npm (spec/02 § Agent backends).
//
// The runtime used to be `npm install @openai/codex@<pinned>`, which needs a
// Node toolchain on the host. A computer with nothing installed has none: the
// host carries its own Node, but not npm. So ChatGPT sign-in, and every Codex
// chat, failed there with `spawn npm ENOENT`.
//
// The package is two tarballs on the npm registry: `@openai/codex` (a Node
// launcher) and its per-platform package, which holds the native `codex`
// binary. This fetches both from the registry over HTTPS, checks each against
// the registry's own sha512 integrity, and unpacks them into the same layout npm
// would leave — `node_modules/@openai/codex/package.json`, and
// `node_modules/.bin/codex` — so nothing that reads the runtime changes. The
// launcher in `.bin` is a shell script that runs the native binary directly,
// with the environment the Node launcher would have given it, so no Node is
// needed to start Codex either.
//
// NO FALLBACK: an unsupported platform, a download that fails, or a tarball
// that does not match its integrity stops the install with what went wrong.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const NPM_REGISTRY = 'https://registry.npmjs.org';
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Codex's own name for each platform it ships a binary for (its `bin/codex.js`). */
export function codexTarget(
  platform: NodeJS.Platform,
  arch: string,
): { triple: string; suffix: string } {
  const table: Record<string, { triple: string; suffix: string }> = {
    'darwin-arm64': { triple: 'aarch64-apple-darwin', suffix: 'darwin-arm64' },
    'darwin-x64': { triple: 'x86_64-apple-darwin', suffix: 'darwin-x64' },
    'linux-x64': { triple: 'x86_64-unknown-linux-musl', suffix: 'linux-x64' },
    'linux-arm64': { triple: 'aarch64-unknown-linux-musl', suffix: 'linux-arm64' },
  };
  const hit = table[`${platform}-${arch}`];
  if (!hit) throw new Error(`Codex publishes no build for ${platform}-${arch}`);
  return hit;
}

/** The launcher npm's `.bin/codex` would be, without Node in between. */
export function codexLauncher(root: string, triple: string, suffix: string): string {
  const pkg = join(root, 'node_modules/@openai/codex');
  const bin = join(root, `node_modules/@openai/codex-${suffix}/vendor/${triple}/bin/codex`);
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    '# Written by the Patch host (codexInstall.ts): runs the pinned native Codex.',
    `CODEX_MANAGED_PACKAGE_ROOT=${q(pkg)}`,
    'CODEX_MANAGED_BY_NPM=1',
    'export CODEX_MANAGED_PACKAGE_ROOT CODEX_MANAGED_BY_NPM',
    `exec ${q(bin)} "$@"`,
    '',
  ].join('\n');
}

export interface RegistryInstallDeps {
  fetchImpl?: typeof fetch;
  /** Unpacks a .tgz into a directory, dropping the leading `package/`. */
  untar?: (file: string, dest: string) => Promise<void>;
  platform?: NodeJS.Platform;
  arch?: string;
  registry?: string;
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ dist?: { tarball?: string; integrity?: string } }> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`The npm registry answered ${res.status} for ${url}`);
  return (await res.json()) as { dist?: { tarball?: string; integrity?: string } };
}

async function download(
  name: string,
  version: string,
  into: string,
  d: Required<Pick<RegistryInstallDeps, 'fetchImpl' | 'registry'>>,
): Promise<string> {
  const meta = await getJson(`${d.registry}/${name}/${version}`, d.fetchImpl);
  const tarball = meta.dist?.tarball;
  const integrity = meta.dist?.integrity;
  if (!tarball || !integrity?.startsWith('sha512-')) {
    throw new Error(`The npm registry gave no tarball and sha512 integrity for ${name}@${version}`);
  }
  const res = await d.fetchImpl(tarball, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Downloading ${tarball} failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (got !== integrity) {
    throw new Error(
      `${name}@${version} does not match the registry's integrity; not installing it`,
    );
  }
  const file = join(into, `${name.replace(/[@/]/g, '_')}-${version}.tgz`);
  writeFileSync(file, bytes);
  return file;
}

async function systemUntar(file: string, dest: string): Promise<void> {
  await run('tar', ['-xzf', file, '-C', dest, '--strip-components=1'], {
    timeout: 5 * 60_000,
    maxBuffer: 1024 * 1024,
  });
}

/** Install `@openai/codex@<version>` for this platform into `root`, npm-shaped. */
export async function installCodexFromRegistry(
  root: string,
  version: string,
  deps: RegistryInstallDeps = {},
): Promise<void> {
  const { triple, suffix } = codexTarget(
    deps.platform ?? process.platform,
    deps.arch ?? process.arch,
  );
  const d = { fetchImpl: deps.fetchImpl ?? fetch, registry: deps.registry ?? NPM_REGISTRY };
  const untar = deps.untar ?? systemUntar;
  const work = mkdtempSync(join(tmpdir(), 'patch-codex-'));
  try {
    const launcherTgz = await download('@openai/codex', version, work, d);
    const nativeTgz = await download('@openai/codex', `${version}-${suffix}`, work, d);
    const pkg = join(root, 'node_modules/@openai/codex');
    const native = join(root, `node_modules/@openai/codex-${suffix}`);
    for (const dir of [pkg, native]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }
    await untar(launcherTgz, pkg);
    await untar(nativeTgz, native);
    const bin = join(root, 'node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    // An npm install left a symlink here; writing through it would overwrite its target.
    rmSync(join(bin, 'codex'), { force: true });
    writeFileSync(join(bin, 'codex'), codexLauncher(root, triple, suffix));
    chmodSync(join(bin, 'codex'), 0o755);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
