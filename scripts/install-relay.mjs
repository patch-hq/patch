// Install the relay (packages/relay) on this box as a systemd user service, the
// same shape as the server: a self-contained copy in ~/.patch-relay (production
// node_modules, dist), never run out of a git checkout. Listens on 127.0.0.1:8787;
// Caddy puts TLS in front (patch.tomchambers.me/relay → 8787, a path on the existing host so it needs no DNS record of its own).
//
//   node scripts/install-relay.mjs [--home=DIR] [--no-restart]
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

export function relayUnit({ home, node }) {
  return `# Written by scripts/install-relay.mjs. Re-running it rewrites this file.
[Unit]
Description=Patch relay
After=network-online.target

[Service]
Type=simple
Environment=PORT=8787 HOST=127.0.0.1
ExecStart=${node} ${home}/current/dist/cli.js
Restart=on-failure
RestartSec=3s

[Install]
WantedBy=default.target
`;
}

/**
 * Where this install builds. A directory of its own each time: building over the
 * one `current` points at deletes the code the running service executes, and a
 * failed deploy then leaves `current` dangling.
 */
export function releasePath(home, now = Date.now()) {
  return `${home}/releases/${now}`;
}

/** Releases to delete: all but the live one and the newest `keep` others. */
export function staleReleases(names, live, keep = 2) {
  const newest = names
    .filter((n) => n !== live)
    .sort((a, b) => Number(b) - Number(a))
    .slice(0, keep);
  return names.filter((n) => n !== live && !newest.includes(n));
}

if (isMain(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const home = resolve(arg('home') ?? `${homedir()}/.patch-relay`);
  const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

  sh('pnpm', ['--filter', '@patch/relay', 'build'], { cwd: root });
  const next = releasePath(home);
  mkdirSync(`${home}/releases`, { recursive: true });
  sh('pnpm', ['--filter', '@patch/relay', 'deploy', '--prod', '--legacy', next], { cwd: root });
  rmSync(`${home}/current.new`, { force: true });
  sh('ln', ['-sfn', next, `${home}/current.new`]);
  renameSync(`${home}/current.new`, `${home}/current`);
  for (const stale of staleReleases(readdirSync(`${home}/releases`), basename(readlinkSync(`${home}/current`)))) {
    rmSync(`${home}/releases/${stale}`, { recursive: true, force: true });
  }

  const unitDir = `${homedir()}/.config/systemd/user`;
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(`${unitDir}/patch-relay.service`, relayUnit({ home, node: process.execPath }));
  if (!process.argv.includes('--no-restart')) {
    sh('systemctl', ['--user', 'daemon-reload']);
    sh('systemctl', ['--user', 'enable', 'patch-relay']);
    sh('systemctl', ['--user', 'restart', 'patch-relay']);
  }
}
