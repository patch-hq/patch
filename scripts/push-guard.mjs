#!/usr/bin/env node
// pre-push: what leaves this machine is public.
//
// This repository is published as it is developed, so a push is a publication.
// It refuses anything that looks like a secret in the files the push changes: a
// token-shaped string, a private key outside the known fixtures, or a value
// from the settings files on this machine.
//
// git runs it with `<remote> <url>` as arguments and one line per ref on stdin:
//   <local ref> <local sha> <remote ref> <remote sha>

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMain } from './lib/is-main.mjs';

const ZERO = /^0+$/;

const TOKEN_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /xox[abp]-[A-Za-z0-9-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
];
// Strings that are obviously test data, not credentials.
const FIXTURE =
  /(x{4,}|0{6,}|test|fake|fixture|example|dummy|placeholder|host-|AAAA|1234|oat01-[a-z]{1,8}\d?$)/i;
// Files whose private-key blocks are published test fixtures or third-party examples.
const KEY_BLOCK_OK =
  /(^docker-compose\.test\.yml$|managed_components\/|\.test\.[cm]?[jt]sx?$|\/test\/)/;

/** Findings for one file's text: [] when clean. Pure, so it can be tested. */
export function scanText(rel, text, knownSecrets = []) {
  const found = [];
  // This guard's own tests are made of secret-shaped strings.
  if (rel === 'scripts/push-guard.test.mjs') return found;
  for (const re of TOKEN_SHAPES) {
    for (const m of text.matchAll(re))
      if (!FIXTURE.test(m[0])) found.push(`${rel}: token-shaped string`);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) && !KEY_BLOCK_OK.test(rel))
    found.push(`${rel}: private key`);
  for (const secret of knownSecrets)
    if (text.includes(secret)) found.push(`${rel}: a value from this machine's settings`);
  return found;
}

/**
 * Values of 16+ characters, named like secrets, from this machine's settings:
 * the server's own env file, plus any files listed in PATCH_SECRET_SOURCES
 * (colon-separated).
 */
function knownSecrets() {
  const files = [
    join(homedir(), '.patch-server/server.env'),
    ...(process.env.PATCH_SECRET_SOURCES ?? '').split(':').filter(Boolean),
  ];
  const values = new Set();
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i < 1 || line.trimStart().startsWith('#')) continue;
      if (!/(SECRET|TOKEN|KEY|PASSWORD|PASS|CREDENTIAL|JWT)/i.test(line.slice(0, i))) continue;
      const v = line
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (v.length >= 16 && !/^(https?:|\/|~)/.test(v) && !/^\d+$/.test(v)) values.add(v);
    }
  }
  return [...values];
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Files touched by the commits a push sends: those the remote does not have yet. */
function changedFiles(localSha, remoteSha) {
  const have = ZERO.test(remoteSha) ? ['--remotes'] : [remoteSha];
  const out = git([
    'log',
    '--name-only',
    '--format=',
    '--diff-filter=d',
    localSha,
    '--not',
    ...have,
  ]);
  return [...new Set(out.split('\n').filter(Boolean))];
}

function main() {
  const lines = readFileSync(0, 'utf8').split('\n').filter(Boolean);
  const secrets = knownSecrets();
  const problems = [];
  for (const line of lines) {
    const [, localSha, , remoteSha] = line.split(' ');
    if (ZERO.test(localSha)) continue; // a delete
    for (const file of changedFiles(localSha, remoteSha)) {
      let text;
      try {
        text = git(['show', `${localSha}:${file}`]);
      } catch {
        continue; // a submodule or similar: nothing to read
      }
      if (text.includes('\0')) continue;
      problems.push(...scanText(file, text, secrets));
    }
  }
  if (problems.length) {
    console.error(`push-guard: REFUSING to push:\n  ${[...new Set(problems)].join('\n  ')}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) main();
