import { describe, expect, it } from 'vitest';
import { canonicalizeHostNames, decode, decodeCompat } from '../src/index.js';

const offline = { type: 'host.offline', hostId: 'h1' };

describe('host rename: legacy daemon names still decode', () => {
  it('canonical names decode as sent', () => {
    expect(decode(JSON.stringify(offline))).toMatchObject(offline);
  });
  it('daemonId + daemon.* decode to the same event', () => {
    const ev = decode(JSON.stringify({ type: 'daemon.offline', daemonId: 'h1' }));
    expect(ev).toMatchObject(offline);
  });
  it('decodeCompat accepts the legacy names too', () => {
    const r = decodeCompat(JSON.stringify({ type: 'daemon.offline', daemonId: 'h1' }));
    expect(r.ok && r.event).toMatchObject(offline);
  });
  it('canonicalizes daemonVersion, clientType and nested daemonId', () => {
    expect(
      canonicalizeHostNames({ clientType: 'host', daemonVersion: '1', rows: [{ daemonId: 'a' }] }),
    ).toEqual({ clientType: 'host', hostVersion: '1', rows: [{ hostId: 'a' }] });
  });
  // A registry.json persisted before the rename. Missing this one mapping
  // took production down: `RegistryFile` is `.strict()`, so the stale key was
  // rejected AND the required `managerHostId` was absent, and the server
  // crash-looped on boot.
  it('canonicalizes homeDaemonId, the one legacy name that is not a bare daemonId', () => {
    expect(canonicalizeHostNames({ version: 1, homeDaemonId: null })).toEqual({
      version: 1,
      managerHostId: null,
    });
    // Already migrated: the canonical field wins and the stale one is left be.
    expect(canonicalizeHostNames({ homeDaemonId: 'h1', managerHostId: 'h2' })).toEqual({
      homeDaemonId: 'h1',
      managerHostId: 'h2',
    });
  });
  it('still rejects a frame with neither id', () => {
    expect(() => decode(JSON.stringify({ type: 'host.offline' }))).toThrow();
  });
});
