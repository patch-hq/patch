// spec/02 § Permission mode — the label is the id, made readable. the user, Patch
// Updates: "have nice names for bypassPermissions, like Bypass permissions etc".

import { describe, it, expect } from 'vitest';
import { permissionModeLabel } from '../lib/permissionModeLabel.js';

describe('permissionModeLabel', () => {
  it('writes each mode in sentence case, in the words the SDK uses', () => {
    expect(permissionModeLabel('auto')).toBe('Auto');
    expect(permissionModeLabel('default')).toBe('Ask');
    expect(permissionModeLabel('acceptEdits')).toBe('Accept edits');
    expect(permissionModeLabel('bypassPermissions')).toBe('Bypass permissions');
    expect(permissionModeLabel('plan')).toBe('Plan');
  });

  it('never invents a word the SDK does not use, except Ask for default', () => {
    // The value is passed to the SDK verbatim, so a label that renames the mode
    // would have the user picking one thing and the model told another. `default`
    // is the exception: it is not the default mode, so it reads as what it does.
    for (const mode of ['auto', 'acceptEdits', 'bypassPermissions', 'plan'] as const) {
      const label = permissionModeLabel(mode).toLowerCase().replace(/ /g, '');
      expect(label).toBe(mode.toLowerCase());
    }
  });

  it('humanises an unknown mode rather than hiding it', () => {
    expect(permissionModeLabel('somethingNewEntirely')).toBe('Something new entirely');
  });
});
