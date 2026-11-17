// How a permission mode is described to a person, whatever provider runs it
// (spec/02 § Permission mode).
//
// The value stored and sent is still the agent SDK's own mode id. The words
// here say what a mode DOES, not what Claude Code calls it, and where a
// provider's behaviour differs they say so per provider. Every surface (web
// setup, settings, composer, job editor, mobile) reads this one table, so a
// mode reads the same on each.
//
// Codex mapping (packages/host/src/codexBackend.ts `codexPermission`):
//   default / acceptEdits -> approval on-request, sandbox workspace-write
//   plan                  -> approval on-request, sandbox read-only
//   bypassPermissions     -> approval never, sandbox danger-full-access
// so in Codex "Ask first" and "Allow edits" are the same setting, and the
// per-provider notes below say exactly that rather than overstating it.

import { PROVIDERS } from './providers.js';
import { PermissionMode } from './events.js';

export interface PermissionModeCopy {
  /** The full name, in a list or a select. */
  readonly label: string;
  /** What the mode does, true of every provider that can run it unless a note overrides. */
  readonly hint: string;
  /** Provider id -> what the mode does there instead, where that differs from `hint`. */
  readonly notes: Readonly<Record<string, string>>;
  /** Is the hint a warning? */
  readonly warns: boolean;
}

export const PERMISSION_MODE_COPY: Record<PermissionMode, PermissionModeCopy> = {
  default: {
    label: 'Ask first',
    hint: 'Asks before changing files or running commands',
    notes: { codex: 'Edits files inside the project, asks before anything outside it' },
    warns: false,
  },
  acceptEdits: {
    label: 'Allow edits',
    hint: 'Edits files freely, asks before running commands',
    notes: {
      codex: 'Edits files inside the project, asks before anything outside it (same as Ask first)',
    },
    warns: false,
  },
  plan: {
    label: 'Plan only',
    hint: 'Reads and plans, changes nothing',
    notes: {},
    warns: false,
  },
  auto: {
    label: 'Auto',
    hint: 'Asks only when something looks risky',
    notes: {},
    warns: false,
  },
  bypassPermissions: {
    label: 'Never ask',
    hint: 'Never asks, so it can delete or overwrite anything',
    notes: {},
    warns: true,
  },
};

/** The order modes are listed in: everyday first, the dangerous one last. */
export const PERMISSION_MODE_ORDER: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
];

function providerModes(id: string): readonly PermissionMode[] {
  const p = PROVIDERS.find((d) => d.id === id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p.permissionModes === 'all' ? PermissionMode.options : p.permissionModes;
}

/**
 * The modes worth offering when these providers are the ones in play: every
 * mode at least one of them can run, in list order. With none connected there
 * is nothing to judge by, so every provider counts.
 */
export function permissionModesForProviders(providerIds: readonly string[]): PermissionMode[] {
  const ids = providerIds.length > 0 ? providerIds : PROVIDERS.map((p) => p.id as string);
  const offered = new Set(ids.flatMap((id) => providerModes(id)));
  return PERMISSION_MODE_ORDER.filter((m) => offered.has(m));
}

/**
 * The mode a new-chat default should be when the one stored cannot be run by
 * any of these providers: `default`, which every provider runs.
 */
export function permissionModeForProviders(
  mode: PermissionMode,
  providerIds: readonly string[],
): PermissionMode {
  return permissionModesForProviders(providerIds).includes(mode) ? mode : 'default';
}

/**
 * One line saying what a mode does for these providers. Where only some of
 * them can run it the line says which; where they differ it says how.
 */
export function permissionModeHint(mode: PermissionMode, providerIds: readonly string[]): string {
  const copy = PERMISSION_MODE_COPY[mode];
  const ids = providerIds.filter((id) => providerModes(id).includes(mode));
  if (ids.length > 0 && ids.every((id) => copy.notes[id] !== undefined)) {
    return copy.notes[ids[0]!]!;
  }
  const parts = [copy.hint];
  for (const id of ids) {
    const note = copy.notes[id];
    if (note !== undefined) parts.push(`${PROVIDERS.find((p) => p.id === id)!.label}: ${note}`);
  }
  if (providerIds.length > 0 && ids.length < providerIds.length) {
    const names = ids.map((id) => PROVIDERS.find((p) => p.id === id)!.label);
    parts.push(`${names.join(' and ')} chats only`);
  }
  return parts.join(' · ');
}

/**
 * A mode's name in a plain list, with the providers that can run it named when
 * not every one in play can (`Auto (Claude only)`).
 */
export function permissionModeOptionLabel(
  mode: PermissionMode,
  providerIds: readonly string[],
): string {
  const label = PERMISSION_MODE_COPY[mode].label;
  const ids = providerIds.filter((id) => providerModes(id).includes(mode));
  if (providerIds.length === 0 || ids.length === providerIds.length || ids.length === 0)
    return label;
  const names = ids.map((id) => PROVIDERS.find((p) => p.id === id)!.label);
  return `${label} (${names.join(' and ')} only)`;
}
