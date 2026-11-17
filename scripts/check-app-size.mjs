#!/usr/bin/env node
// Fails when a packaged desktop app is bigger than its budget, so the size
// cannot creep back (it reached ~950 MB once because the host build and every
// platform's native modules were carried by accident).
//
//   node scripts/check-app-size.mjs <app dir> <budget MB> [--top=N]
//
// Size is the bytes of every file under the directory (symlinks counted as
// links, not followed). On failure the largest top-level items are listed, so
// the culprit is visible in the CI log.

import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';

export function sizeOf(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of readdirSync(path)) total += sizeOf(join(path, name));
  return total;
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(0);

/** Returns { ok, bytes, report } for `dir` against `budgetMb`. */
export function checkSize(dir, budgetMb, top = 8) {
  const bytes = sizeOf(dir);
  const ok = bytes <= budgetMb * 1024 * 1024;
  const lines = [`${dir}: ${mb(bytes)} MB (budget ${budgetMb} MB)`];
  if (!ok) {
    // One level into Contents/Resources (or resources) shows host/server/asar apart.
    const parts = [];
    const walk = (d, depth) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = lstatSync(p);
        if (st.isDirectory() && depth < 2) walk(p, depth + 1);
        else parts.push([sizeOf(p), p]);
      }
    };
    walk(dir, 0);
    parts.sort((a, b) => b[0] - a[0]);
    for (const [size, p] of parts.slice(0, top)) lines.push(`  ${mb(size).padStart(5)} MB  ${p.slice(dir.length + 1)}`);
  }
  return { ok, bytes, report: lines.join('\n') };
}

if (isMain(import.meta.url)) {
  const [dir, budget] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const budgetMb = Number(budget);
  if (!dir || !Number.isFinite(budgetMb) || budgetMb <= 0) {
    console.error('usage: check-app-size.mjs <app dir> <budget MB>');
    process.exit(64);
  }
  const { ok, report } = checkSize(resolve(dir), budgetMb);
  console.log(report);
  if (!ok) {
    console.error('check-app-size: over budget — something large is being packaged that should not be');
    process.exit(1);
  }
}
