#!/usr/bin/env node
// The slices of the test gate (scripts/verify.mjs) a run needs, one per runner,
// printed as JSON for the matrix in .github/workflows/test.yml.
//
//   node scripts/ci-plan.mjs --all               main: every layer, every package,
//                                                the browser layer in four shards
//   node scripts/ci-plan.mjs --base origin/main  a PR: the cheap layers, and the
//                                                unit suites this diff reaches
//
// Each slice is {name, layers, packages, shard, system}: the verify.mjs
// --layers and --packages it runs, its PATCH_BROWSER_SHARD, and whether the
// runner needs Chromium, Xvfb and the keyring. Together a run's slices cover
// every layer it is meant to run; no runner repeats another's work.
//
// A PR runs the packages its diff touches and everything that depends on them
// (turbo's --affected). Turbo does not count a change outside the workspace
// packages: a lockfile bump, the root tsconfig or a vitest config "affects"
// nothing by its reckoning. So any change outside packages/ and apps/ that is
// not plain documentation runs every package. Main always runs everything.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The suites big enough to want a runner each; the rest share one.
// host ~8 min, web ~4.5 min, everything else together ~5.5 min (Nov 2026).
const OWN_RUNNER = ['@patch/host', '@patch/web'];

/** Root-level paths that cannot change a unit suite's result. */
const DOC_ONLY = [/^spec\//, /^docs\//, /^design\//, /^[^/]+\.md$/];

/** Does this diff reach outside the packages in a way turbo cannot attribute? */
export function forcesAll(changedFiles) {
  return changedFiles.some(
    (f) => !/^(packages|apps)\/[^/]+\//.test(f) && !DOC_ONLY.some((re) => re.test(f)),
  );
}

/** Split the packages to test into runner-sized groups: {name, packages}. */
export function buckets(packages) {
  const out = [];
  for (const p of OWN_RUNNER) {
    if (packages.includes(p)) out.push({ name: p.replace('@patch/', ''), packages: p });
  }
  const rest = packages.filter((p) => !OWN_RUNNER.includes(p)).sort();
  if (rest.length) out.push({ name: 'rest', packages: rest.join(',') });
  return out;
}

// The browser layer on one runner took about an hour.
export const BROWSER_SHARDS = 4;

/** The matrix: the cheap layers, the unit buckets, and on main the browser shards. */
export function slices(packages, { browser }) {
  const out = [
    {
      name: 'checks',
      layers: 'lint,types,mock,personal,scripts',
      packages: '',
      shard: '',
      system: false,
    },
  ];
  for (const b of buckets(packages)) {
    out.push({
      name: `unit ${b.name}`,
      layers: 'unit',
      packages: b.packages,
      shard: '',
      system: true,
    });
  }
  if (browser) {
    for (let i = 1; i <= BROWSER_SHARDS; i++) {
      const shard = `${i}/${BROWSER_SHARDS}`;
      out.push({ name: `browser ${shard}`, layers: 'browser', packages: '', shard, system: true });
    }
  }
  return out;
}

function turboLs(extraArgs, env) {
  const out = execFileSync('pnpm', ['exec', 'turbo', 'ls', ...extraArgs, '--output=json'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  // turbo may print notices before the JSON.
  const json = JSON.parse(out.slice(out.indexOf('{')));
  return json.packages.items.map((i) => i.name);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx === -1 ? undefined : argv[baseIdx + 1];
  if (!all && !base) throw new Error('ci-plan: pass --all or --base <ref>');

  let packages;
  let why;
  if (all) {
    packages = turboLs([]);
    why = 'all packages (--all)';
  } else {
    const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    if (forcesAll(changed)) {
      packages = turboLs([]);
      why = `all packages: the diff changes files outside the packages (${changed
        .filter((f) => forcesAll([f]))
        .slice(0, 5)
        .join(', ')})`;
    } else {
      packages = turboLs(['--affected'], { TURBO_SCM_BASE: base });
      why = `affected by ${changed.length} changed file(s)`;
    }
  }
  console.error(`ci-plan: ${why}: ${packages.join(', ') || 'none'}`);
  console.log(JSON.stringify(slices(packages, { browser: all })));
}
