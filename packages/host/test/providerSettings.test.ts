// spec/10 § Provider settings: Patch writes only what the user chose into the
// provider's own configuration, and never replaces a file it cannot edit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyClaudeProviderSettings } from '../src/providerSettings.js';
import { InvalidSettingsJsonError } from '../src/claudeSettings.js';

let home: string;
const file = (): string => join(home, 'settings.json');
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'prov-settings-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('applyClaudeProviderSettings', () => {
  it('writes nothing when the user chose nothing', () => {
    writeFileSync(file(), '{"model":"x"}');
    expect(applyClaudeProviderSettings(home, {})).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe('{"model":"x"}');
  });

  it('does not create a settings.json for a setting nobody chose', () => {
    expect(applyClaudeProviderSettings(home, {})).toEqual([]);
    expect(() => readFileSync(file(), 'utf8')).toThrow();
  });

  it('writes the chosen value and keeps every other key', () => {
    writeFileSync(file(), '{"model":"x","hooks":{"a":1}}');
    expect(applyClaudeProviderSettings(home, { claude: { cleanupPeriodDays: 90 } })).toEqual([
      'cleanupPeriodDays',
    ]);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({
      model: 'x',
      hooks: { a: 1 },
      cleanupPeriodDays: 90,
    });
  });

  it('creates the file when there is none and a value was chosen', () => {
    applyClaudeProviderSettings(home, { claude: { cleanupPeriodDays: 7 } });
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ cleanupPeriodDays: 7 });
  });

  it('leaves a file that already agrees untouched', () => {
    writeFileSync(file(), '{"cleanupPeriodDays":90}');
    expect(applyClaudeProviderSettings(home, { claude: { cleanupPeriodDays: 90 } })).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe('{"cleanupPeriodDays":90}');
  });

  it('refuses a setting the provider does not declare', () => {
    expect(() => applyClaudeProviderSettings(home, { claude: { nope: 1 } })).toThrow(/no setting/);
  });

  it('reports a settings.json that is not an object and leaves it as it was', () => {
    writeFileSync(file(), '{not json');
    expect(() => applyClaudeProviderSettings(home, { claude: { cleanupPeriodDays: 5 } })).toThrow(
      InvalidSettingsJsonError,
    );
    expect(readFileSync(file(), 'utf8')).toBe('{not json');
    writeFileSync(file(), '[1]');
    expect(() => applyClaudeProviderSettings(home, { claude: { cleanupPeriodDays: 5 } })).toThrow(
      InvalidSettingsJsonError,
    );
  });
});
