#!/usr/bin/env node
// Assembles the vendored build inputs for `scripts/build-host.mjs` from public
// sources, so a clean machine (CI, a contributor) can build a host without a
// directory somebody copied around by hand.
//
//   <out>/node/node-v<pin>-<target>/bin/node   nodejs.org, checked against SHASUMS256.txt
//   <out>/onnxruntime-node/                    the package installed by pnpm: package.json,
//                                              dist/, and <target>/ = its napi-v6 prebuild
//   <out>/models/silero_vad.onnx               snakers4/silero-vad at a pinned tag, checked
//                                              against a pinned sha256
//   <out>/models/smart_turn.onnx               pipecat-ai/smart-turn-v3 (v3.2, CPU) at a pinned
//                                              commit, checked against a pinned sha256
//
// Run `pnpm install` first: the onnxruntime files come from the install, which
// is what ties them to the version the host is built against.
//
// NO FALLBACK: a download that does not match its checksum, a missing install or
// a target with no prebuild stops with the reason. Nothing is guessed at.
//
//   node scripts/fetch-vendor.mjs --out=DIR [--targets=darwin-arm64,linux-x64,linux-arm64]
//
// Then:  PATCH_BUILD_VENDOR=DIR node scripts/build-host.mjs

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The exact Node the host ships with. The major must match .nvmrc. */
export const NODE_PIN = '22.23.2';
export const SILERO = {
  url: 'https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.1/src/silero_vad/data/silero_vad.onnx',
  sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
};
/** Dictation mode's end-of-turn model (BSD-2), ~8.7 MB. */
export const SMART_TURN = {
  url: 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx',
  sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f',
};
export const TARGETS = {
  'darwin-arm64': { platform: 'darwin', arch: 'arm64' },
  'linux-x64': { platform: 'linux', arch: 'x64' },
  'linux-arm64': { platform: 'linux', arch: 'arm64' },
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * A stalled connection from a CI runner is the usual failure here, so each
 * attempt gets a short timeout and a few are made against the same pinned URL.
 * Every attempt is logged and the last error is thrown: nothing is swallowed.
 */
async function download(url, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.error(`download ${url} attempt ${i}/${attempts} failed: ${err.message}`);
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 5_000 * i));
    }
  }
}

/** The checksum line for `file` in a nodejs.org SHASUMS256.txt, or throw. */
export function checksumFor(shasums, file) {
  const line = shasums.split('\n').find((l) => l.trim().endsWith(`  ${file}`));
  if (!line) throw new Error(`${file} is not listed in SHASUMS256.txt`);
  return line.trim().split(/\s+/)[0];
}

export function assertNodePinMatchesNvmrc(pin, nvmrc) {
  const major = nvmrc.trim().replace(/^v/, '').split('.')[0];
  if (pin.split('.')[0] !== major) {
    throw new Error(`NODE_PIN ${pin} is not on the Node ${major} line that .nvmrc names`);
  }
}

async function fetchNode(out, target) {
  const dir = join(out, 'node', `node-v${NODE_PIN}-${target}`);
  if (existsSync(join(dir, 'bin', 'node'))) return console.log(`node ${target}: present`);
  const base = `https://nodejs.org/dist/v${NODE_PIN}`;
  const file = `node-v${NODE_PIN}-${target}.tar.gz`;
  const expected = checksumFor((await download(`${base}/SHASUMS256.txt`)).toString('utf8'), file);
  const tarball = await download(`${base}/${file}`);
  if (sha256(tarball) !== expected) throw new Error(`${file} does not match its published checksum`);
  const work = mkdtempSync(join(tmpdir(), 'patch-vendor-'));
  try {
    writeFileSync(join(work, file), tarball);
    mkdirSync(dirname(dir), { recursive: true });
    execFileSync('tar', ['-xzf', join(work, file), '-C', dirname(dir)]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (!existsSync(join(dir, 'bin', 'node'))) throw new Error(`${file} did not unpack to ${dir}`);
  console.log(`node ${target}: ${NODE_PIN}`);
}

function installedOnnx() {
  const pnpm = join(REPO_ROOT, 'node_modules', '.pnpm');
  const hits = existsSync(pnpm) ? readdirSync(pnpm).filter((n) => n.startsWith('onnxruntime-node@')) : [];
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one onnxruntime-node in node_modules/.pnpm, found ${hits.length}. Run pnpm install.`,
    );
  }
  return join(pnpm, hits[0], 'node_modules', 'onnxruntime-node');
}

function fetchOnnx(out, targets) {
  const src = installedOnnx();
  const dest = join(out, 'onnxruntime-node');
  mkdirSync(dest, { recursive: true });
  cpSync(join(src, 'package.json'), join(dest, 'package.json'));
  cpSync(join(src, 'dist'), join(dest, 'dist'), { recursive: true });
  for (const target of targets) {
    const { platform, arch } = TARGETS[target];
    const prebuilt = join(src, 'bin', 'napi-v6', platform, arch);
    if (!existsSync(prebuilt)) throw new Error(`onnxruntime-node ships no prebuild for ${target} (${prebuilt})`);
    cpSync(prebuilt, join(dest, target), { recursive: true });
    console.log(`onnxruntime-node ${target}: ${JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version}`);
  }
}

async function fetchSilero(out) {
  const file = join(out, 'models', 'silero_vad.onnx');
  if (existsSync(file) && sha256(readFileSync(file)) === SILERO.sha256) return console.log('silero_vad.onnx: present');
  const body = await download(SILERO.url);
  if (sha256(body) !== SILERO.sha256) throw new Error('silero_vad.onnx does not match its pinned checksum');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  console.log('silero_vad.onnx: v6.2.1');
}

async function fetchSmartTurn(out) {
  const file = join(out, 'models', 'smart_turn.onnx');
  if (existsSync(file) && sha256(readFileSync(file)) === SMART_TURN.sha256) return console.log('smart_turn.onnx: present');
  const body = await download(SMART_TURN.url);
  if (sha256(body) !== SMART_TURN.sha256) throw new Error('smart_turn.onnx does not match its pinned checksum');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  console.log('smart_turn.onnx: v3.2-cpu');
}

async function main() {
  const args = process.argv.slice(2);
  const val = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const out = val('out');
  if (!out) throw new Error('--out=DIR is required');
  const targets = (val('targets') ?? Object.keys(TARGETS).join(',')).split(',');
  for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target ${t}`);
  assertNodePinMatchesNvmrc(NODE_PIN, readFileSync(join(REPO_ROOT, '.nvmrc'), 'utf8'));
  mkdirSync(resolve(out), { recursive: true });
  for (const t of targets) await fetchNode(resolve(out), t);
  fetchOnnx(resolve(out), targets);
  await fetchSilero(resolve(out));
  await fetchSmartTurn(resolve(out));
  console.log(`vendor ready: ${resolve(out)}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`fetch-vendor: ${err.message}`);
    process.exit(1);
  });
}
