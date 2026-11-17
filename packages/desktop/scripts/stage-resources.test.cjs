const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { stage, wanted, pruneNativeModules } = require('./stage-resources.cjs');

function repo(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'patch-stage-'));
  const host = path.join(root, 'repo', 'dist', 'host');
  mkdirSync(host, { recursive: true });
  for (const f of files) writeFileSync(path.join(host, f), f);
  return { repoRoot: path.join(root, 'repo'), desktopDir: path.join(root, 'desktop') };
}
const fakeRelease = (out) => {
  const dir = path.join(out, 'patch-server-1');
  mkdirSync(path.join(dir, 'server'), { recursive: true });
  writeFileSync(path.join(dir, 'patch-server'), '#!/bin/sh');
  return dir;
};

test('carries the manifest, the installer and only this Mac’s host build', () => {
  const r = repo([
    'host-latest.json',
    'install.sh',
    'patch-host-1-darwin-arm64.tar.gz',
    'patch-host-1-darwin-arm64.tar.gz.sig',
    'patch-host-1-linux-x64.tar.gz',
    'patch-host-1-linux-arm64.tar.gz',
  ]);
  const staged = stage({ ...r, buildServer: fakeRelease, target: 'darwin-arm64' });
  assert.deepEqual(readdirSync(path.join(staged, 'host')).sort(), [
    'host-latest.json',
    'install.sh',
    'patch-host-1-darwin-arm64.tar.gz',
    'patch-host-1-darwin-arm64.tar.gz.sig',
  ]);
  assert.deepEqual(readdirSync(path.join(staged, 'server')).sort(), ['patch-server', 'server']);
  assert.deepEqual(readdirSync(staged).sort(), ['host', 'server']);
});

test('the AppImage carries the linux-x64 host build and nothing else', () => {
  const r = repo([
    'host-latest.json',
    'install.sh',
    'patch-host-1-darwin-arm64.tar.gz',
    'patch-host-1-linux-x64.tar.gz',
    'patch-host-1-linux-x64.tar.gz.sig',
    'patch-host-1-linux-arm64.tar.gz',
  ]);
  const staged = stage({ ...r, buildServer: fakeRelease, target: 'linux-x64' });
  assert.deepEqual(readdirSync(path.join(staged, 'host')).sort(), [
    'host-latest.json',
    'install.sh',
    'patch-host-1-linux-x64.tar.gz',
    'patch-host-1-linux-x64.tar.gz.sig',
  ]);
});

test('electron-builder copies exactly the staged folders the first run reads', () => {
  // first-run/index.ts reads resources/server and resources/host. The config once
  // copied build/staged/daemon, which nothing stages, and the app shipped hostless.
  const yml = readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  for (const dir of ['server', 'host']) {
    assert.match(yml, new RegExp(`from: build/staged/${dir}\\n\\s+to: ${dir}\\n`));
  }
  const firstRun = readFileSync(path.join(__dirname, '..', 'src', 'first-run', 'index.ts'), 'utf8');
  assert.match(firstRun, /join\(env\.resources, 'server'\)/);
  assert.match(firstRun, /join\(env\.resources, 'host'\)/);
});

test('refuses to package an app with no host build, naming what to run', () => {
  const r = repo([]);
  assert.throws(() => stage({ ...r, buildServer: fakeRelease }), /pnpm build:host/);
});

test('refuses a host directory with no installer for the host', () => {
  const r = repo(['host-latest.json', 'patch-host-1-linux-x64.tar.gz']);
  assert.throws(
    () => stage({ ...r, buildServer: fakeRelease, target: 'linux-x64' }),
    /no install\.sh/,
  );
});

test('refuses a host directory that has nothing for this Mac', () => {
  const r = repo(['host-latest.json', 'install.sh', 'patch-host-1-linux-x64.tar.gz']);
  assert.throws(
    () => stage({ ...r, buildServer: fakeRelease, target: 'darwin-arm64' }),
    /no darwin-arm64/,
  );
});

test('wanted() keeps non-tarballs and darwin-arm64 tarballs', () => {
  assert.equal(wanted('install.sh'), true);
  assert.equal(wanted('x-darwin-arm64.tar.gz'), true);
  assert.equal(wanted('x-linux-x64.tar.gz'), false);
  assert.equal(wanted('x-linux-x64.tar.gz', 'linux-x64'), true);
  assert.equal(wanted('x-linux-arm64.tar.gz', 'linux-x64'), false);
});

test('does not carry the folder the host tarball was made from', () => {
  const r = repo(['host-latest.json', 'install.sh', 'patch-host-1-darwin-arm64.tar.gz']);
  mkdirSync(path.join(r.repoRoot, 'dist', 'host', 'patch-host-1-darwin-arm64', 'node_modules'), { recursive: true });
  const staged = stage({ ...r, buildServer: fakeRelease, target: 'darwin-arm64' });
  assert.deepEqual(readdirSync(path.join(staged, 'host')).sort(), [
    'host-latest.json',
    'install.sh',
    'patch-host-1-darwin-arm64.tar.gz',
  ]);
});

test('prunes sharp builds for other platforms, with their links, and keeps this one', () => {
  const server = mkdtempSync(path.join(tmpdir(), 'patch-prune-'));
  const pnpm = path.join(server, 'node_modules', '.pnpm');
  const names = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linuxmusl-arm64'];
  mkdirSync(path.join(pnpm, 'node_modules', '@img'), { recursive: true });
  mkdirSync(path.join(pnpm, 'sharp@1', 'node_modules', '@img'), { recursive: true });
  for (const n of names) {
    for (const pkg of ['sharp', 'sharp-libvips']) {
      const real = path.join(pnpm, `@img+${pkg}-${n}@1`);
      mkdirSync(real, { recursive: true });
      writeFileSync(path.join(real, 'x.node'), 'x');
      symlinkSync(real, path.join(pnpm, 'sharp@1', 'node_modules', '@img', `${pkg}-${n}`));
    }
  }
  mkdirSync(path.join(pnpm, '@img+sharp-wasm32@1'));
  const removed = pruneNativeModules(server, 'darwin-arm64');
  assert.equal(removed, 12);
  assert.deepEqual(readdirSync(pnpm).filter((n) => n.startsWith('@img')).sort(), [
    '@img+sharp-darwin-arm64@1',
    '@img+sharp-libvips-darwin-arm64@1',
    '@img+sharp-wasm32@1',
  ]);
  assert.deepEqual(readdirSync(path.join(pnpm, 'sharp@1', 'node_modules', '@img')).sort(), [
    'sharp-darwin-arm64',
    'sharp-libvips-darwin-arm64',
  ]);
  assert.equal(existsSync(path.join(pnpm, '@img+sharp-darwin-arm64@1', 'x.node')), true);
});
