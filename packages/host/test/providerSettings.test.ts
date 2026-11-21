// spec/10 § Provider settings (decision 9): Patch writes only what the user
// chose into each provider's own configuration, in the provider's own form, and
// never replaces a file it cannot edit. One writer, driven by the provider table
// and each ACP agent's entry: Claude Code's settings.json, Codex's config.toml
// in each CODEX_HOME, Gemini CLI's settings.json.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ACP_AGENTS, providerDescriptor, type OwnSetting } from '@patch/wire';
import { applyOwnSettings, ownConfigFile, readProviderSetting } from '../src/providerSettings.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prov-settings-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const claude = providerDescriptor('claude');
const codex = providerDescriptor('codex');
const gemini = BUILTIN_ACP_AGENTS.find((a) => a.id === 'gemini')!.ownSettings!;

describe('Claude Code: cleanupPeriodDays in settings.json', () => {
  const file = (): string => join(dir, 'settings.json');
  const apply = (chosen?: Record<string, number>) =>
    applyOwnSettings([ownConfigFile(file())], 'json', claude.settings, chosen);

  it('writes nothing when the user chose nothing, so Claude Code’s own value stands', () => {
    writeFileSync(file(), '{"model":"x"}');
    expect(apply(undefined)).toEqual([]);
    expect(apply({})).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe('{"model":"x"}');
  });

  it('writes the chosen value and keeps everything else', () => {
    writeFileSync(file(), '{"model":"x"}');
    expect(apply({ cleanupPeriodDays: 90 })).toEqual([
      { file: file(), written: ['cleanupPeriodDays'] },
    ]);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ model: 'x', cleanupPeriodDays: 90 });
    expect(readProviderSetting(readFileSync(file(), 'utf8'), 'cleanupPeriodDays')).toBe(90);
  });

  it('leaves a file that already agrees byte-for-byte alone', () => {
    writeFileSync(file(), '{ "cleanupPeriodDays": 90 }');
    expect(apply({ cleanupPeriodDays: 90 })).toEqual([{ file: file(), written: [] }]);
    expect(readFileSync(file(), 'utf8')).toBe('{ "cleanupPeriodDays": 90 }');
  });

  it('reports a settings.json that is not an object, and leaves it as it was', () => {
    writeFileSync(file(), '{not json');
    expect(() => apply({ cleanupPeriodDays: 5 })).toThrow(/not valid JSON/);
    expect(readFileSync(file(), 'utf8')).toBe('{not json');
    writeFileSync(file(), '[1]');
    expect(() => apply({ cleanupPeriodDays: 5 })).toThrow(/must be a JSON object/);
  });
});

describe('Codex: [history] in each CODEX_HOME’s config.toml', () => {
  const homes = ['account-a', 'endpoints'];
  const files = () => homes.map((h) => ownConfigFile(join(dir, h, 'config.toml')));
  const read = (h: string) => readFileSync(join(dir, h, 'config.toml'), 'utf8');
  const apply = (chosen?: Record<string, number>) =>
    applyOwnSettings(files(), 'toml', codex.settings, chosen);

  it('declares its prompt history, which is what Codex’s own config offers, and still says sessions are kept', () => {
    expect(codex.settings.map((s) => s.key)).toEqual(['history.persistence', 'history.max_bytes']);
    expect(codex.settingsNote).toMatch(/no setting to delete old sessions/);
    expect(codex.ownConfigFormat).toBe('toml');
  });

  it('writes nothing when nothing is chosen, and creates no file', () => {
    expect(apply({})).toEqual([]);
    expect(existsSync(join(dir, 'account-a', 'config.toml'))).toBe(false);
  });

  it('writes the chosen values in Codex’s own words and units into every home, keeping the rest', () => {
    const existing = '[projects."/home/u/work"]\ntrust_level = "trusted"\n';
    mkdirSync(join(dir, 'account-a'), { recursive: true });
    writeFileSync(join(dir, 'account-a', 'config.toml'), existing);
    apply({ 'history.persistence': 0, 'history.max_bytes': 5 });
    expect(read('account-a')).toBe(
      `${existing}\n[history]\npersistence = "none"\nmax_bytes = 5242880\n`,
    );
    expect(read('endpoints')).toBe('[history]\npersistence = "none"\nmax_bytes = 5242880\n');
    // Changing one value edits that line only.
    apply({ 'history.persistence': 1, 'history.max_bytes': 5 });
    expect(read('account-a')).toBe(
      `${existing}\n[history]\npersistence = "save-all"\nmax_bytes = 5242880\n`,
    );
    // Already agreeing: nothing written.
    expect(apply({ 'history.persistence': 1 }).every((w) => w.written.length === 0)).toBe(true);
  });

  it('edits an existing [history] table in place, comments and other keys kept', () => {
    mkdirSync(join(dir, 'account-a'), { recursive: true });
    writeFileSync(
      join(dir, 'account-a', 'config.toml'),
      '[history]\n# mine\npersistence = "save-all" # keep\nother = 1\n\n[tui]\nx = 1\n',
    );
    applyOwnSettings(
      [ownConfigFile(join(dir, 'account-a', 'config.toml'))],
      'toml',
      codex.settings,
      { 'history.persistence': 0, 'history.max_bytes': 2 },
    );
    expect(read('account-a')).toBe(
      '[history]\n# mine\npersistence = "none"\nother = 1\nmax_bytes = 2097152\n\n[tui]\nx = 1\n',
    );
  });

  it('refuses a [history] it would have to guess at, writes the other homes, and names the file', () => {
    mkdirSync(join(dir, 'account-a'), { recursive: true });
    writeFileSync(join(dir, 'account-a', 'config.toml'), 'history = { persistence = "none" }\n');
    expect(() => apply({ 'history.persistence': 1 })).toThrow(
      /account-a\/config\.toml: \[history\] is defined in a form this writer does not edit/,
    );
    expect(read('account-a')).toBe('history = { persistence = "none" }\n');
    expect(read('endpoints')).toBe('[history]\npersistence = "save-all"\n');
  });
});

describe('Gemini CLI: general.sessionRetention in its own settings.json', () => {
  const file = (): string => join(dir, '.gemini', 'settings.json');
  const apply = (chosen?: Record<string, number>) =>
    applyOwnSettings([ownConfigFile(file())], 'json', gemini.settings, chosen);

  it('is declared on the Gemini CLI entry, where its own settings live', () => {
    expect(gemini.file).toBe('.gemini/settings.json');
    expect(gemini.homeEnv).toBe('GEMINI_CLI_HOME');
    expect(gemini.settings.map((s) => s.key)).toEqual([
      'general.sessionRetention.enabled',
      'general.sessionRetention.maxAge',
    ]);
  });

  it('writes the age as Gemini’s own duration and the switch as a boolean, inside its nesting', () => {
    apply({ 'general.sessionRetention.maxAge': 7 });
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({
      general: { sessionRetention: { maxAge: '7d' } },
    });
    writeFileSync(file(), JSON.stringify({ general: { vimMode: true }, ui: { theme: 'x' } }));
    apply({ 'general.sessionRetention.enabled': 0, 'general.sessionRetention.maxAge': 14 });
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({
      general: { vimMode: true, sessionRetention: { enabled: false, maxAge: '14d' } },
      ui: { theme: 'x' },
    });
  });

  it('refuses a nesting it would have to overwrite', () => {
    mkdirSync(join(dir, '.gemini'), { recursive: true });
    writeFileSync(file(), '{"general":"nope"}');
    expect(() => apply({ 'general.sessionRetention.maxAge': 7 })).toThrow(
      /general is not an object/,
    );
    expect(readFileSync(file(), 'utf8')).toBe('{"general":"nope"}');
  });
});

describe('a setting with no chosen value is never written', () => {
  it('for every declared setting of every kind', () => {
    const all: OwnSetting[] = [...claude.settings, ...codex.settings, ...gemini.settings];
    for (const s of all) {
      expect(applyOwnSettings([ownConfigFile(join(dir, 'f'))], 'json', [s], {})).toEqual([]);
    }
    expect(existsSync(join(dir, 'f'))).toBe(false);
  });
});
