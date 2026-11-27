// The local administrator's secret (spec/10 § Local credentials).
//
// Something running on the server's own machine — a scheduled check, an agent
// driving the web app headlessly — needs a surface credential without anyone
// approving it from another device. Whoever can read the server's data folder
// can already read the account's signing key, so the proof asked of them is the
// same: read this file. The server writes it once, owner-only, and accepts it on
// one route, `POST /api/auth/local/credential`.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCAL_ADMIN_TOKEN_FILE = 'local-admin.token';
export const LOCAL_ADMIN_HEADER = 'x-patch-local-admin';

/** Read the data folder's local-admin secret, writing a new one the first time. */
export function ensureLocalAdminToken(dataDir: string): string {
  const path = join(dataDir, LOCAL_ADMIN_TOKEN_FILE);
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(token)) {
      throw new Error(`${path} is not a local-admin secret; delete it and restart the server`);
    }
    chmodSync(path, 0o600);
    return token;
  }
  const token = randomBytes(32).toString('hex');
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return token;
}

/** Constant-time check of a presented secret against the server's own. */
export function localAdminTokenMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A stable surface id per label, so re-issuing renews one device instead of adding another. */
export function localSurfaceId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('label has no letters or digits');
  return `local-${slug}`;
}
