// permissionModeLabel — how a permission mode is written on screen.
//
// The value itself is the agent SDK's own `permissionMode` and is passed
// through verbatim (spec/02 § Permission mode). The label is the same words as
// the id, cased and spaced for reading, with one exception: `default` reads
// "Ask". It is not the default (`auto` is), so "Default" beside a preselected
// Auto contradicted itself; "Ask" is what it does, and the word the composer
// already uses for it.

import type { PermissionMode } from '@patch/wire';

const LABELS: Record<string, string> = {
  auto: 'Auto',
  default: 'Ask',
  acceptEdits: 'Accept edits',
  bypassPermissions: 'Bypass permissions',
  plan: 'Plan',
};

/**
 * The on-screen label for a mode. An unknown mode (a newer SDK's, reaching an
 * older surface) is split on its camelCase humps and sentence-cased by the same
 * rule, rather than falling back to something that hides what it actually is.
 */
export function permissionModeLabel(mode: PermissionMode | string): string {
  const known = LABELS[mode];
  if (known !== undefined) return known;
  const spaced = mode.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
