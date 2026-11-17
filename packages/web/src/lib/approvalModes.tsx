// How the composer's approval control reads each permission mode: a short word
// for the trigger, a line saying what the mode does for the list, and an icon
// the trigger can shrink to when the row is tight (spec/14 § Composer —
// Approval mode). The icons are the ones the phone's padlock already uses
// (spec/15), so a mode looks the same on both. The value sent is still the
// SDK's own id; only the words on screen are shorter.

import type { JSX } from 'react';
import { ClipboardList, FilePen, Lock, LockOpen, Sparkles } from 'lucide-react';
import { PERMISSION_MODE_COPY, type PermissionMode } from '@patch/wire';
import { permissionModeLabel } from './permissionModeLabel.js';

const WORDS: Record<string, string> = {
  default: 'Ask',
  acceptEdits: 'Edits',
  plan: 'Plan',
  auto: 'Auto',
  bypassPermissions: 'Bypass',
};

/** The trigger's word; an unknown (newer SDK) mode falls back to its full label. */
export function approvalWord(mode: PermissionMode | string): string {
  return WORDS[mode] ?? permissionModeLabel(mode);
}

export function approvalDescription(mode: PermissionMode | string): string | undefined {
  return (PERMISSION_MODE_COPY as Record<string, { hint: string } | undefined>)[mode]?.hint;
}

export function ApprovalIcon({
  mode,
  size,
}: {
  mode: PermissionMode | string | undefined;
  size: number;
}): JSX.Element {
  switch (mode) {
    case 'acceptEdits':
      return <FilePen size={size} aria-hidden />;
    case 'plan':
      return <ClipboardList size={size} aria-hidden />;
    case 'auto':
      return <Sparkles size={size} aria-hidden />;
    case 'bypassPermissions':
      return <LockOpen size={size} aria-hidden />;
    default:
      return <Lock size={size} aria-hidden />;
  }
}
