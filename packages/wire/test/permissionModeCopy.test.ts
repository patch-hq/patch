import { describe, expect, it } from 'vitest';
import {
  PERMISSION_MODE_COPY,
  permissionModeForProviders,
  permissionModeHint,
  permissionModeOptionLabel,
  permissionModesForProviders,
} from '../src/index.js';

describe('permission mode copy', () => {
  it('offers no Auto to a Codex-only user', () => {
    expect(permissionModesForProviders(['codex'])).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
    ]);
  });

  it('offers Auto when Claude is connected', () => {
    expect(permissionModesForProviders(['claude'])).toContain('auto');
    expect(permissionModesForProviders(['claude', 'codex'])).toContain('auto');
  });

  it('counts every provider when none is connected', () => {
    expect(permissionModesForProviders([])).toContain('auto');
  });

  it('moves a default no connected provider can run to default', () => {
    expect(permissionModeForProviders('auto', ['codex'])).toBe('default');
    expect(permissionModeForProviders('auto', ['claude'])).toBe('auto');
    expect(permissionModeForProviders('plan', ['codex'])).toBe('plan');
  });

  it('says Auto is for Claude chats only when both are connected', () => {
    expect(permissionModeHint('auto', ['claude', 'codex'])).toContain('Claude chats only');
    expect(permissionModeOptionLabel('auto', ['claude', 'codex'])).toBe('Auto (Claude only)');
    expect(permissionModeOptionLabel('auto', ['claude'])).toBe('Auto');
  });

  it('describes a mode by ChatGPT behaviour when only Codex runs it', () => {
    expect(permissionModeHint('default', ['codex'])).toBe(PERMISSION_MODE_COPY.default.notes.codex);
    expect(permissionModeHint('default', ['claude', 'codex'])).toContain('ChatGPT:');
    expect(permissionModeHint('plan', ['claude', 'codex'])).toBe(
      'Reads and plans, changes nothing',
    );
  });

  it('uses no Claude Code vocabulary in a label', () => {
    for (const c of Object.values(PERMISSION_MODE_COPY)) {
      expect(c.label).not.toMatch(/accept edits|bypass permissions/i);
    }
  });
});
