import { mkdtempSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkLegacySocket } from '../src/legacySocket.js';

describe('linkLegacySocket', () => {
  it('links daemon.sock to host.sock, replacing a stale socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-'));
    const stale = createServer();
    await new Promise<void>((r) => stale.listen(join(dir, 'daemon.sock'), r));
    stale.close();
    linkLegacySocket(join(dir, 'host.sock'));
    expect(readlinkSync(join(dir, 'daemon.sock'))).toBe(join(dir, 'host.sock'));
    linkLegacySocket(join(dir, 'host.sock')); // idempotent
    expect(lstatSync(join(dir, 'daemon.sock')).isSymbolicLink()).toBe(true);
  });
  it('does nothing for a custom socket name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-'));
    linkLegacySocket(join(dir, 'custom.sock'));
    expect(() => lstatSync(join(dir, 'daemon.sock'))).toThrow();
  });
  it('refuses to replace a regular file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-'));
    writeFileSync(join(dir, 'daemon.sock'), 'x');
    expect(() => linkLegacySocket(join(dir, 'host.sock'))).toThrow(/Refusing/);
  });
});
