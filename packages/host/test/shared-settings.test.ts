// A host's half of the shared settings (spec/01 § Settings): how a Codex login
// is found to be sent up.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexKeyringUser, readCodexAuth, writeCodexAuth } from '../src/sharedSettings.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-shared-settings-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Codex logins', () => {
  it('reads auth.json when Codex stores to a file, and writes one with mode 0600', () => {
    const home = join(dir, 'codex-a');
    writeCodexAuth(home, '{"tokens":{"access_token":"x"}}');
    expect(readCodexAuth(home)).toBe('{"tokens":{"access_token":"x"}}');
    expect(statSync(join(home, 'auth.json')).mode & 0o777).toBe(0o600);
  });

  it('falls back to the keyring entry Codex keeps for that home, and says none when there is none', () => {
    const home = join(dir, 'codex-b');
    const calls: string[][] = [];
    const found = readCodexAuth(home, (cmd, args) => {
      calls.push([cmd, ...args]);
      return '{"tokens":{}}\n';
    });
    expect(found).toBe('{"tokens":{}}');
    expect(calls[0]).toContain(codexKeyringUser(home));
    expect(
      readCodexAuth(home, () => {
        throw new Error('no such secret');
      }),
    ).toBeUndefined();
  });

  it('names the keyring entry the way Codex does: a hash of the home path', () => {
    expect(
      codexKeyringUser('/home/claude-dev/.patch/openai/e8b86f06-3e98-4a17-86bd-a2e37938d479'),
    ).toBe('cli|3f5e791a694533dc');
  });
});
