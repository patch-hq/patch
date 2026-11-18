// The downloads folder gains every release's artifacts and nothing removed them:
// a server that ran for months held 1,500 files and filled its disk. After each
// mirror check this keeps the newest few versions plus anything a manifest
// (*-latest.json, latest-*.yml) still names, and deletes the rest.

import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP_VERSIONS = 3;

// `<name>-<x.y.z>...`: Patch-1.1.1552.dmg, patch-host-1.1.1558-linux-x64.tar.gz, patch-1.1.1552.apk.
const VERSIONED = /^(?:patch|Patch)(?:-host)?-(\d+)\.(\d+)\.(\d+)(?=[-.])/;
const MANIFEST = /(?:-latest\.json|^latest[\w-]*\.yml|^mobile-update\.json)$/;

function versionOf(name: string): [number, number, number] | null {
  const m = VERSIONED.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const cmp = (a: number[], b: number[]): number => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

/** Deletes old versioned release files; returns the names removed. Never touches unversioned files or directories. */
export function pruneDownloads(
  dir: string,
  log: (msg: string) => void = () => {},
  keep = KEEP_VERSIONS,
): string[] {
  const names = readdirSync(dir);
  const manifestText = names
    .filter((n) => MANIFEST.test(n))
    .map((n) => readFileSync(join(dir, n), 'utf8'))
    .join('\n');
  const versions = new Map<string, [number, number, number]>();
  for (const n of names) {
    const v = versionOf(n);
    if (v) versions.set(v.join('.'), v);
  }
  const newest = new Set(
    [...versions.entries()]
      .sort((a, b) => cmp(b[1], a[1]))
      .slice(0, keep)
      .map(([k]) => k),
  );
  const removed: string[] = [];
  let bytes = 0;
  for (const n of names) {
    const v = versionOf(n);
    if (!v || newest.has(v.join('.')) || manifestText.includes(n)) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (!st.isFile()) continue;
    unlinkSync(p);
    removed.push(n);
    bytes += st.size;
  }
  if (removed.length > 0) {
    log(
      `release prune: removed ${removed.length} old files (${Math.round(bytes / 1e6)} MB) from ${dir}`,
    );
  }
  return removed;
}
