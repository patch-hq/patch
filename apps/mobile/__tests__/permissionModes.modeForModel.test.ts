// lib/permissionModes.ts — a picked mode only stands while the model can run it.

import { describe, it, expect } from 'vitest';
import { modeForModel } from '../src/lib/permissionModes';

describe('modeForModel', () => {
  it('keeps a mode the model can run', () => {
    expect(modeForModel('auto', 'claude-sonnet-4-6')).toBe('auto');
    expect(modeForModel('plan', 'claude-haiku-4-5')).toBe('plan');
  });

  it('drops auto for a model that cannot run it, back to the host default', () => {
    expect(modeForModel('auto', 'claude-haiku-4-5')).toBeNull();
    expect(modeForModel('auto', 'claude-opus-4-5')).toBeNull();
  });

  it('has nothing to judge an unknown model by, so keeps the mode; and keeps "no choice"', () => {
    expect(modeForModel('auto', null)).toBe('auto');
    expect(modeForModel(null, 'claude-haiku-4-5')).toBeNull();
  });
});
