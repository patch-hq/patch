// Each provider's own settings (spec/10 § Provider settings; decision 9): one
// table-driven list, each value kept as a number and written in the provider's
// own form.

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ACP_AGENTS,
  describeOwnSetting,
  invalidOwnSettingValue,
  ownSettingValue,
  ownSettingsGroups,
  providerDescriptor,
  AcpAgentConfig,
} from '../src/index.js';

describe('ownSettingsGroups', () => {
  it('lists each provider’s from the table, then each ACP agent that declares some', () => {
    expect(ownSettingsGroups(undefined).map((g) => [g.id, g.settings.map((s) => s.key)])).toEqual([
      ['claude', ['cleanupPeriodDays']],
      ['codex', ['history.persistence', 'history.max_bytes']],
      ['acp:gemini', ['general.sessionRetention.enabled', 'general.sessionRetention.maxAge']],
    ]);
  });

  it('shows none for an agent without its own settings, and a configured agent’s own', () => {
    const groups = ownSettingsGroups([
      { id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
      {
        id: 'other',
        label: 'Other',
        command: 'other',
        args: [],
        ownSettings: {
          file: '.other/config.json',
          settings: [
            {
              key: 'keepDays',
              label: 'Keep',
              description: 'd',
              kind: 'days',
              min: 1,
              max: 9,
              providerDefault: 3,
              write: { as: 'number' },
            },
          ],
        },
      },
    ]);
    expect(groups.map((g) => g.id)).toEqual(['claude', 'codex', 'acp:other']);
  });

  it('refuses an agent file outside the home directory', () => {
    const bad = (file: string) =>
      AcpAgentConfig.safeParse({
        id: 'x',
        label: 'X',
        command: 'x',
        args: [],
        ownSettings: { file, settings: BUILTIN_ACP_AGENTS[0]!.ownSettings!.settings },
      }).success;
    expect(bad('/etc/passwd')).toBe(false);
    expect(bad('../x.json')).toBe(false);
    expect(bad('.x/settings.json')).toBe(true);
  });
});

describe('a setting’s number in the provider’s own form', () => {
  const [persistence, maxBytes] = providerDescriptor('codex').settings;
  const [enabled, maxAge] = BUILTIN_ACP_AGENTS[0]!.ownSettings!.settings;
  it('writes each kind as its provider reads it', () => {
    expect(ownSettingValue(persistence!, 0)).toBe('none');
    expect(ownSettingValue(persistence!, 1)).toBe('save-all');
    expect(ownSettingValue(maxBytes!, 2)).toBe(2 * 1024 * 1024);
    expect(ownSettingValue(enabled!, 0)).toBe(false);
    expect(ownSettingValue(maxAge!, 14)).toBe('14d');
    expect(ownSettingValue(providerDescriptor('claude').settings[0]!, 90)).toBe(90);
  });
  it('says each value the same way on every surface', () => {
    expect(describeOwnSetting(persistence!, 1)).toBe('On');
    expect(describeOwnSetting(maxBytes!, null)).toBe('No limit');
    expect(describeOwnSetting(maxAge!, 1)).toBe('1 day');
  });
  it('refuses a value the setting does not take', () => {
    expect(invalidOwnSettingValue(persistence!, 2)).toMatch(/on \(1\) or off \(0\)/);
    expect(invalidOwnSettingValue(maxAge!, 0)).toMatch(/from 1 to 3650/);
    expect(invalidOwnSettingValue(maxAge!, 1.5)).toMatch(/whole number/);
    expect(invalidOwnSettingValue(maxAge!, 7)).toBeNull();
  });
});
