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
