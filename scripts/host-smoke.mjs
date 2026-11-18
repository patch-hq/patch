#!/usr/bin/env node
// Release gate: install the real, signed host artifact the way an update does
// and prove it stays up. Run by release.yml on every host build, before the
// artifact is uploaded for `publish`.
//
//   node scripts/host-smoke.mjs --artifact <patch-host-*.tar.gz> [--seconds 60] [--scan-only]
//
// --scan-only does step 1-2 only, for a target the runner cannot execute (linux-arm64).
//
// What it does, in order:
//   1. unpacks the tarball into a staging dir (what selfUpdate does);
//   2. fails on any symlink in the artifact that is absolute, dangling or points
//      outside the artifact (it would not survive being copied to ~/.patch);
//   3. copies it into a scratch HOME's ~/.patch/versions/<v> with the same
//      cpSync the installer uses, installs the runtime node as the installer does,
//      then DELETES the staging dir (the updater removes its temp dir);
//   4. fails on any dangling symlink left in the installed tree;
//   5. starts the host directly (a runner has no launchd or user systemd) with a
//      pre-seeded credential and a server address nothing listens on, so it never
//      contacts a real server or pairs with one. The host retries its link
//      forever, so a healthy host stays up;
//   6. polls /healthz for --seconds and fails if the process exits or /healthz
//      stops answering, printing the host's own output.
//
// Why this exists: 1.1.1593 shipped a relative symlink for onnxruntime that
// cpSync rewrote to an absolute path inside the updater's temp dir; the dir was
// deleted and the host crashed at boot on every install.
//
// NO FALLBACK: any problem exits non-zero with the reason.

import { spawn, execFileSync } from 'node:child_process';
import {
  cpSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';

/**
 * Every symlink under `root` that would not survive a copy: absolute, pointing
 * outside `root`, or dangling. Returns human-readable problems.
 */
export function symlinkProblems(root) {
  const problems = [];
  const rootReal = realpathSync(root);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!st.isSymbolicLink()) continue;
      const target = readlinkSync(p);
      const shown = `${relative(root, p)} -> ${target}`;
      if (isAbsolute(target)) {
        problems.push(`absolute symlink: ${shown}`);
        continue;
      }
      const resolved = resolve(dirname(p), target);
      const rel = relative(rootReal, resolve(realpathSync(dirname(p)), target));
      if (rel.startsWith('..') || isAbsolute(rel)) {
        problems.push(`symlink leaves the tree: ${shown}`);
      } else if (!existsSync(resolved)) {
        problems.push(`dangling symlink: ${shown}`);
      }
    }
  };
  walk(root);
  return problems;
}

/** A TCP port nothing is listening on. */
function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

function parseArgs(argv) {
  const a = { seconds: 60 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--artifact') a.artifact = argv[++i];
    else if (argv[i] === '--scan-only') a.scanOnly = true;
    else if (argv[i] === '--seconds') a.seconds = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!a.artifact) throw new Error('--artifact <tar.gz> is required');
  if (!Number.isFinite(a.seconds) || a.seconds <= 0) throw new Error('--seconds must be positive');
  return a;
}

function fail(msg) {
  console.error(`host-smoke: FAIL — ${msg}`);
  process.exit(1);
}

async function healthz(port) {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function main(argv) {
  const args = parseArgs(argv);
  const tarball = resolve(args.artifact);
  if (!existsSync(tarball)) fail(`no such artifact ${tarball}`);

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'host-smoke-')));
  const home = join(scratch, 'home');
  const staging = join(scratch, 'staging');
  mkdirSync(home);
  mkdirSync(staging);
  let child;
  let log = '';
  try {
    // 1. Unpack as the updater does.
    execFileSync('tar', ['-xzf', tarball, '-C', staging]);
    const dirs = readdirSync(staging);
    if (dirs.length !== 1) fail(`expected one top-level folder in the artifact, found ${dirs.join(', ')}`);
    const extracted = join(staging, dirs[0]);
    const info = JSON.parse(readFileSync(join(extracted, 'build-info.json'), 'utf8'));
    console.log(`host-smoke: ${info.target} ${info.version} (${info.gitSha})`);

    // 2. Symlinks in the artifact itself.
    const bad = symlinkProblems(extracted);
    if (bad.length) fail(`the artifact has symlinks that will not survive an install:\n  ${bad.join('\n  ')}`);

    if (args.scanOnly) {
      console.log('host-smoke: OK — symlinks only (this runner cannot execute the target)');
      return;
    }

    // 3. Install, as installer/main.ts does (keep in step with it).
    const patchHome = join(home, '.patch');
    const installDir = join(patchHome, 'versions', info.version);
    mkdirSync(installDir, { recursive: true });
    cpSync(extracted, installDir, { recursive: true, verbatimSymlinks: true });
    for (const exe of ['node', 'install']) {
      const p = join(installDir, exe);
      if (existsSync(p)) chmodSync(p, 0o755);
    }
    const runtimeDir = join(patchHome, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    let nodePath;
    if (info.target.startsWith('darwin')) {
      cpSync(join(installDir, 'Patch Host.app'), join(runtimeDir, 'Patch Host.app'), { recursive: true, verbatimSymlinks: true });
      nodePath = join(runtimeDir, 'Patch Host.app', 'Contents', 'MacOS', 'patch-host');
    } else {
      nodePath = join(runtimeDir, 'patch-host');
      const tmp = `${nodePath}.new`;
      copyFileSync(join(installDir, 'node'), tmp);
      chmodSync(tmp, 0o755);
      renameSync(tmp, nodePath);
    }
    if (!existsSync(nodePath)) fail(`the installed runtime is missing: ${nodePath}`);

    // The updater deletes its staging dir once the installer has run.
    rmSync(staging, { recursive: true, force: true });

    // 4. Nothing in the installed tree may depend on the staging dir.
    const dangling = symlinkProblems(installDir);
    if (dangling.length) fail(`the installed host has broken symlinks:\n  ${dangling.join('\n  ')}`);

    // 5. Start it, talking to nothing. A credential is seeded so it does not
    //    try to pair; its payload is all the host reads.
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    writeFileSync(
      join(patchHome, 'host.key'),
      `${b64({ alg: 'none' })}.${b64({ sub: 'smoke', daemon_id: 'host-smoke' })}.smoke\n`,
      { mode: 0o600 },
    );
    const [deadPort, healthPort, audioPort] = [await freePort(), await freePort(), await freePort()];
    child = spawn(nodePath, [join(installDir, 'host.mjs')], {
      cwd: home,
      env: {
        HOME: home,
        USER: 'smoke',
        PATH: process.env.PATH,
        PATCH_SERVER_URL: `http://127.0.0.1:${deadPort}`,
        PATCH_SERVER_WS_URL: `ws://127.0.0.1:${deadPort}/ws`,
        PATCH_HOST_NAME: 'host-smoke',
        PATCH_INTERNAL_TOKEN: 'smoke',
        SDK_BACKEND: 'real',
        VAD_BACKEND: 'silero',
        VAD_MODEL_PATH: join(installDir, 'silero_vad.onnx'),
        PATCH_DAEMON_HEALTHZ_PORT: String(healthPort),
        PATCH_DAEMON_AUDIO_PORT: String(audioPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let exited;
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('exit', (code, sig) => (exited = `exit code ${code}, signal ${sig}`));

    // 6. Alive and answering for the whole window.
    const deadline = Date.now() + args.seconds * 1000;
    let answered = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (exited) fail(`the host died (${exited}). Its output:\n${log.slice(-4000)}`);
      try {
        const h = await healthz(healthPort);
        if (h.version !== info.version) fail(`/healthz reports ${h.version}, expected ${info.version}`);
        answered = true;
      } catch (err) {
        if (answered) fail(`/healthz stopped answering (${err.message}). Output:\n${log.slice(-4000)}`);
      }
    }
    if (!answered) fail(`the host never answered /healthz in ${args.seconds}s. Output:\n${log.slice(-4000)}`);
    console.log(`host-smoke: OK — ${info.target} ${info.version} stayed up for ${args.seconds}s`);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => fail(err.stack ?? String(err)));
}
