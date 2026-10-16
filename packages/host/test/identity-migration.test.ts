import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostIdentityPath, loadOrCreateHostIdentity, readHostIdentity } from '../src/identity.js';

describe('host identity written before the rename', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('reads daemonId as hostId and rewrites the file once in the new format', () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-identity-'));
    dirs.push(home);
    const fresh = loadOrCreateHostIdentity(home);
    const { hostId, ...rest } = JSON.parse(readFileSync(hostIdentityPath(home), 'utf8'));
    writeFileSync(hostIdentityPath(home), JSON.stringify({ daemonId: hostId, ...rest }));

    expect(readHostIdentity(home)?.hostId).toBe(fresh.hostId);
    const onDisk = JSON.parse(readFileSync(hostIdentityPath(home), 'utf8'));
    expect(onDisk.hostId).toBe(fresh.hostId);
    expect('daemonId' in onDisk).toBe(false);
  });
});
