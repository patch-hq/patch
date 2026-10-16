#!/usr/bin/env node
// Mark a development build stable.
//
//   node scripts/promote.mjs 1.1.42         # dev-1.1.42 → v1.1.42
//   node scripts/promote.mjs                # the newest dev release
//
// Stable is not a rebuild. The files a dev release published — the ones that
// have been running on the dev channel — are published again, unchanged, as the
// stable release v<version> on the same commit. Servers on the stable channel
// pick it up from there.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMain } from './lib/is-main.mjs';

const REPO = 'tomchambers2/patch';

const gh = (args, opts = {}) =>
  execFileSync('gh', [...args, '--repo', REPO], { encoding: 'utf8', ...opts }).trim();

/** The dev release to promote: the one named, or the newest. */
export function pickDevTag(releases, version) {
  const dev = releases.filter((r) => r.tagName.startsWith('dev-') && !r.isDraft);
  if (version) {
    const want = `dev-${version}`;
    if (!dev.some((r) => r.tagName === want)) throw new Error(`there is no release ${want}`);
    return want;
  }
  if (dev.length === 0) throw new Error('there are no dev releases to promote');
  return dev.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0].tagName;
}

function main() {
  const releases = JSON.parse(
    gh(['release', 'list', '--limit', '100', '--json', 'tagName,isDraft,createdAt']),
  );
  const devTag = pickDevTag(releases, process.argv[2]);
  const version = devTag.slice('dev-'.length);
  const stableTag = `v${version}`;
  if (releases.some((r) => r.tagName === stableTag)) throw new Error(`${stableTag} already exists`);

  const sha = gh(['release', 'view', devTag, '--json', 'targetCommitish', '--jq', '.targetCommitish']);
  const work = mkdtempSync(join(tmpdir(), 'patch-promote-'));
  try {
    gh(['release', 'download', devTag, '--dir', work], { stdio: ['ignore', 'pipe', 'inherit'] });
    const assets = readdirSync(work).map((n) => join(work, n));
    if (assets.length === 0) throw new Error(`${devTag} has no assets`);
    gh(
      [
        'release', 'create', stableTag, ...assets,
        '--target', sha,
        '--title', `Patch ${version}`,
        '--generate-notes',
        '--latest',
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`promote: ${devTag} is now stable as ${stableTag} (${sha.slice(0, 8)})`);
}

if (isMain(import.meta.url)) main();
