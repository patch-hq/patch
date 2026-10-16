// Settings → Hooks editor state (spec/20-hooks.md, spec/14 § Hooks): the draft a
// hook is edited as, and its conversion to and from the wire shapes. Mirrors
// packages/web/src/routes/settings/HooksPage.tsx so both surfaces write the
// same body.

import type { Hook, HookCreateBody, HookKind } from '@patch/wire/hooks';

export interface HookDraft {
  id: string | null;
  name: string;
  kind: HookKind;
  command: string;
  instructions: string;
  model: string;
  hosts: string[];
  folders: string[];
  chatIds: string[];
  specialThreads: boolean;
  filter: string;
  timeoutMs: string;
  enabled: boolean;
}

export function blankDraft(): HookDraft {
  return {
    id: null,
    name: '',
    kind: 'script',
    command: '',
    instructions: '',
    model: '',
    hosts: [],
    folders: [],
    chatIds: [],
    specialThreads: false,
    filter: '',
    timeoutMs: '',
    enabled: true,
  };
}

export function draftFromHook(h: Hook): HookDraft {
  return {
    id: h.id,
    name: h.name,
    kind: h.kind,
    command: h.script?.command ?? '',
    instructions: h.prompt?.instructions ?? '',
    model: h.prompt?.model ?? '',
    hosts: h.gate.hosts ?? [],
    folders: h.gate.folders ?? [],
    chatIds: h.gate.chatIds ?? [],
    specialThreads: h.gate.specialThreads === true,
    filter: h.gate.filter ?? '',
    timeoutMs: String(h.timeoutMs),
    enabled: h.enabled,
  };
}

const listOrNull = (items: string[]): string[] | null => (items.length > 0 ? items : null);

export function draftToBody(d: HookDraft): HookCreateBody {
  const timeoutMs = d.timeoutMs.trim() === '' ? undefined : Number(d.timeoutMs);
  return {
    name: d.name.trim(),
    when: 'user_message',
    kind: d.kind,
    ...(d.kind === 'script' ? { script: { command: d.command } } : {}),
    ...(d.kind === 'prompt' ? { prompt: { instructions: d.instructions, model: d.model } } : {}),
    gate: {
      hosts: listOrNull(d.hosts),
      folders: listOrNull(d.folders),
      chatIds: listOrNull(d.chatIds),
      specialThreads: d.specialThreads,
      filter: d.filter.trim() === '' ? null : d.filter.trim(),
    },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    enabled: d.enabled,
  };
}

/** Blank (the hook's own default) or a whole number of milliseconds, 1 or more. */
export function timeoutOk(raw: string): boolean {
  return raw.trim() === '' || /^[1-9]\d*$/.test(raw.trim());
}

export function canSave(d: HookDraft): boolean {
  return (
    timeoutOk(d.timeoutMs) &&
    d.name.trim() !== '' &&
    (d.kind === 'script'
      ? d.command.trim() !== ''
      : d.instructions.trim() !== '' && d.model.trim() !== '')
  );
}

/** Toggle one value in a gate list, keeping the rest. */
export function toggleIn(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
