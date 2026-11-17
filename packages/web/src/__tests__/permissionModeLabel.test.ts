// spec/02 § Permission mode — a mode is named by what it does, in words that
// belong to no one provider (the table lives in @patch/wire).

import { describe, it, expect } from 'vitest';
import { permissionModeLabel } from '../lib/permissionModeLabel.js';

describe('permissionModeLabel', () => {
  it('names each mode by what it does', () => {
    expect(permissionModeLabel('auto')).toBe('Auto');
    expect(permissionModeLabel('default')).toBe('Ask first');
    expect(permissionModeLabel('acceptEdits')).toBe('Allow edits');
    expect(permissionModeLabel('bypassPermissions')).toBe('Never ask');
    expect(permissionModeLabel('plan')).toBe('Plan only');
  });

  it('humanises an unknown mode rather than hiding it', () => {
    expect(permissionModeLabel('somethingNewEntirely')).toBe('Something new entirely');
  });
});
