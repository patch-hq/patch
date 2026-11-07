#!/usr/bin/env node
// Does this release change anything inside the Mac app?
//
// The Mac app is not just its shell: it carries the whole server, the web UI
// and a host (for running Patch entirely on one Mac), so almost any change to
// those is a change to the app, and gets a new build. What it does NOT carry is
// the phone app, the specs and docs, the tests, and the infrastructure around
// them. A release that only touches those would otherwise ship a byte-for-byte
// equivalent Mac app under a new version number — and every running copy would
// ask its user to restart for nothing. Patch releases ~20 times a day.
//
// So the rule is: list what is provably NOT in the app, and build whenever any
// changed path falls outside that list. An unknown path counts as in the app.
// Getting this wrong in the safe direction costs one unnecessary prompt; the
// other direction would ship a Mac app missing a real change.
//
// Usage (release.yml):
//   node scripts/desktop-scope.mjs <sha of the last Mac app build>   → build | reuse
// An empty sha (no Mac app built yet) prints `build`.

import { execFileSync } from 'node:child_process';
import { isMain } from './lib/is-main.mjs';

/** Path prefixes nothing in the Mac app is built from. */
const NOT_IN_APP_PREFIXES = [
  'apps/', // the phone app
  'spec/',
  'docs/',
  'design/',
  'testing/',
  'deploy/', // the production box's own scripts
  'packages/voice-firmware/',
  '.github/', // except the release workflow, which decides how the app is built
];

/** Whole files at the repository root that are not in the app. */
const NOT_IN_APP_ROOT_FILES = [
  /^[^/]+\.md$/,
  /^docker-compose[^/]*\.yml$/,
  /^Caddyfile$/,
  /^LICENSE$/,
  /^app\.json$/, // Expo's config: the phone app
  /^\.easignore$/,
  /^\.dockerignore$/,
  /^\.env\.example$/,
];

/** Tests, anywhere: bundles are built from entry points and never include them. */
const TEST_PATHS = [/(^|\/)(__tests__|e2e|test|fixtures)\//, /\.(test|spec)\.[cm]?[jt]sx?$/];

const ALWAYS_IN_APP = new Set(['.github/workflows/release.yml']);

/** True when a change to this path could change the Mac app. */
export function inMacApp(path) {
  if (ALWAYS_IN_APP.has(path)) return true;
  if (NOT_IN_APP_PREFIXES.some((p) => path.startsWith(p))) return false;
  if (NOT_IN_APP_ROOT_FILES.some((re) => re.test(path))) return false;
  if (TEST_PATHS.some((re) => re.test(path))) return false;
  return true;
}

/** `build` when any changed path is in the app, else `reuse`. */
export function decide(changedPaths) {
  return changedPaths.some(inMacApp) ? 'build' : 'reuse';
}

function main() {
  const base = process.argv[2] ?? '';
  if (base === '') {
    console.error('desktop-scope: no previous Mac app build, so this release builds one');
    console.log('build');
    return;
  }
  // NO FALLBACK: a base this checkout cannot resolve is an error, not a guess.
  const changed = execFileSync('git', ['diff', '--name-only', `${base}`, 'HEAD'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const inApp = changed.filter(inMacApp);
  const decision = decide(changed);
  console.error(
    decision === 'build'
      ? `desktop-scope: ${inApp.length} of ${changed.length} changed files since ${base} are in the Mac app, e.g. ${inApp.slice(0, 5).join(', ')}`
      : `desktop-scope: none of the ${changed.length} files changed since ${base} are in the Mac app; reusing that build`,
  );
  console.log(decision);
}

if (isMain(import.meta.url)) main();
