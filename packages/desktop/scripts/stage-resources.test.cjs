const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { stage, wanted } = require('./stage-resources.cjs');

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

test('electron-builder copies the staged folders the first run reads', () => {
  // first-run/index.ts reads resources/server and resources/host. The config once
  // copied build/staged/daemon, which nothing stages, and the app shipped hostless.
  // The Mac app does not carry the host yet (it fails notarisation), the AppImage does.
  const yml = readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  assert.match(yml, /from: build\/staged\/server\n\s+to: server\n/);
  const linux = yml.slice(yml.indexOf('\nlinux:'));
  assert.match(linux, /from: build\/staged\/host\n\s+to: host\n/);
  assert.doesNotMatch(yml, /staged\/daemon/);
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
