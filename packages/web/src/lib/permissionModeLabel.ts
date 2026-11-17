// permissionModeLabel — how a permission mode is written on screen.
//
// The stored value is the agent SDK's own `permissionMode`, passed through
// verbatim (spec/02 § Permission mode); the words come from the provider-
// neutral table in @patch/wire (`PERMISSION_MODE_COPY`), which says what a mode
// does rather than using one provider's vocabulary.

import { PERMISSION_MODE_COPY, type PermissionMode } from '@patch/wire';

/**
 * The on-screen label for a mode. An unknown mode (a newer SDK's, reaching an
 * older surface) is split on its camelCase humps and sentence-cased by the same
 * rule, rather than falling back to something that hides what it actually is.
 */
export function permissionModeLabel(mode: PermissionMode | string): string {
  const known = (PERMISSION_MODE_COPY as Record<string, { label: string } | undefined>)[mode];
  if (known !== undefined) return known.label;
  const spaced = mode.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
