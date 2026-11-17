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
//
// The stable release also carries each download under a name that never changes
// (`stableAliases`), so the website can link to
// https://github.com/patch-hq/patch/releases/latest/download/<name> and always
// hand out the newest stable build. The versioned files stay too: the update
// feeds (latest-mac.yml, latest-linux.yml, android-latest.json) name those.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMain } from './lib/is-main.mjs';

const REPO = 'patch-hq/patch';

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

/**
 * The fixed-name copies a stable release publishes, from the release's own file
 * names. Required ones must each match exactly one file, or the promotion stops:
 * a website link that 404s, or serves the wrong build, is not a release.
 */
export const STABLE_ALIASES = [
  { alias: 'Patch-mac-arm64.zip', from: /^Patch-[\d.]+-arm64-mac\.zip$/, required: true },
  { alias: 'Patch-linux-x86_64.AppImage', from: /^Patch-[\d.]+-x86_64\.AppImage$/, required: true },
  { alias: 'Patch-android.apk', from: /^patch-[\d.]+\.apk$/, required: true },
  // The server installer already has a fixed name; it must be there.
  { alias: 'install.sh', from: /^install\.sh$/, required: true },
  // The disk image is newer than the zip; a release built before it has none.
  { alias: 'Patch-mac-arm64.dmg', from: /^Patch-[\d.]+-arm64\.dmg$/, required: false },
];

/** `[{ from, to }]` copies to make; `to === from` means the file already has its fixed name. */
export function stableAliases(names) {
  const out = [];
  for (const { alias, from, required } of STABLE_ALIASES) {
    const hits = names.filter((n) => from.test(n));
    if (hits.length > 1) throw new Error(`more than one file could be ${alias}: ${hits.join(', ')}`);
    if (hits.length === 0) {
      if (required) throw new Error(`the release has no file for ${alias} (wanted ${from})`);
      continue;
    }
    out.push({ from: hits[0], to: alias });
  }
  return out;
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
    const names = readdirSync(work);
    if (names.length === 0) throw new Error(`${devTag} has no assets`);
    // Fixed names alongside the versioned files (see the top of this file).
    for (const { from, to } of stableAliases(names)) {
      if (from !== to) copyFileSync(join(work, from), join(work, to));
      console.log(`promote: ${to} ← ${from}`);
    }
    const assets = readdirSync(work).map((n) => join(work, n));
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
