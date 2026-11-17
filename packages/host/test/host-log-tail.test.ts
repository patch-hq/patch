// The installer's revoked check must read only what the new start wrote.

import { mkdirSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostLogSize, hostLogTail } from '../src/installer/service.js';

describe('hostLogTail since a mark', () => {
  it('leaves out a 4401 written before the mark', () => {
    const home = mkdtempSync(join(tmpdir(), 'hostlog-'));
    mkdirSync(join(home, '.patch', 'logs'), { recursive: true });
    const log = join(home, '.patch', 'logs', 'daemon.log');
    appendFileSync(log, 'host socket closed 4401\n');
    const mark = hostLogSize(home);
    appendFileSync(log, 'host authed\n');
    expect(hostLogTail(home, 40, mark)).toBe('host authed');
    expect(hostLogTail(home, 40)).toContain('4401');
  });
});
