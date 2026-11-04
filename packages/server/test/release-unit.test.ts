import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RELEASE = join(__dirname, '..', 'release');

describe('server installer service unit', () => {
  it('writes the patch-server unit with Restart=always', () => {
    const src = readFileSync(join(RELEASE, 'install'), 'utf8');
    expect(src).toMatch(/ExecStart=.*patch-server\nRestart=always/);
  });
});

describe('server installer socket unit', () => {
  const src = readFileSync(join(RELEASE, 'install'), 'utf8');
  it('has a socket unit hold the port and the service require it, so a restart never closes it', () => {
    expect(src).toMatch(/cat > "\$\{SOCKET_NEW\}"/);
    expect(src).toMatch(/Requires=patch-server\.socket/);
    expect(src).toMatch(/ListenStream=\$\{LISTEN_HOST_ENV:-127\.0\.0\.1\}:\$\{PORT\}/);
  });
  it('restarts only the service for a release, and the socket only when its address changed', () => {
    expect(src).toMatch(/\$\{SYSTEMCTL\} restart patch-server\n/);
    expect(src).toMatch(/elif \[ "\$\{SOCKET_CHANGED\}" = 1 \]/);
  });
});
