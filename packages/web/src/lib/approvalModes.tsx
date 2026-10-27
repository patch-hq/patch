// How the composer's approval control reads each permission mode: a short word
// for the trigger, a line saying what the mode does for the list, and an icon
// the trigger can shrink to when the row is tight (spec/14 § Composer —
// Approval mode). The icons are the ones the phone's padlock already uses
// (spec/15), so a mode looks the same on both. The value sent is still the
// SDK's own id; only the words on screen are shorter.

import type { JSX } from 'react';
import { ClipboardList, FilePen, Lock, LockOpen, Sparkles } from 'lucide-react';
import type { PermissionMode } from '@patch/wire';
import { permissionModeLabel } from './permissionModeLabel.js';

const WORDS: Record<string, { word: string; description: string }> = {
  default: { word: 'Ask', description: 'Asks before each action' },
  acceptEdits: { word: 'Edits', description: 'Edits files without asking' },
  plan: { word: 'Plan', description: 'Plans only, changes nothing' },
  auto: { word: 'Auto', description: 'Decides what needs asking' },
  bypassPermissions: { word: 'Bypass', description: 'No checks at all' },
};

/** The trigger's word; an unknown (newer SDK) mode falls back to its full label. */
export function approvalWord(mode: PermissionMode | string): string {
  return WORDS[mode]?.word ?? permissionModeLabel(mode);
}

export function approvalDescription(mode: PermissionMode | string): string | undefined {
  return WORDS[mode]?.description;
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
