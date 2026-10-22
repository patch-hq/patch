// The keymap (spec/14 ## Keyboard shortcuts → Customising): every chord the
// app dispatches itself is a named action with a default and an optional
// per-machine override. Settings → Shortcuts edits the overrides; the shortcut
// hook and the nav-history controls read through `matchesAction`, and every
// label the UI draws comes from `actionGlyphs`, so a chord is only ever defined
// here.
//
// A chord is written once in macOS glyphs (`⌘⇧N`) for defaults. A modifier left
// out of a default is required ABSENT, except ⇧ on `?` (the key already is a
// shifted character on most layouts). `mod` is ⌘ on a Mac and Ctrl elsewhere
// (either satisfies it); `ctrl` is the literal Ctrl key.
//
// Like the dictate chord (lib/dictateChord.ts) overrides are kept per machine
// in localStorage: a chord belongs to the keyboard it is pressed on.

import { chordKeyGlyph, MODIFIER_CODES } from './dictateChord.js';
import { isMacKeyboard } from './sendChord.js';

export interface Chord {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  /** `undefined` = either (only the `?` default). */
  shift?: boolean;
  /** `KeyboardEvent.key`, compared case-insensitively. Defaults only. */
  key?: string;
  /** `KeyboardEvent.code`. Recorded chords; the physical key. */
  code?: string;
}

export type ActionId =
  | 'cheatSheet'
  | 'search'
  | 'searchFind'
  | 'toggleSidebar'
  | 'newChat'
  | 'newChatPicker'
  | 'prevChat'
  | 'nextChat'
  | 'prevFolder'
  | 'nextFolder'
  | 'jumpManager'
  | 'toggleChannels'
  | 'jumpUnread'
  | 'toggleArchived'
  | 'archiveCurrent'
  | 'filePicker'
  | 'searchInFiles'
  | 'diffViewer'
  | 'fileBrowser'
  | 'toggleTerminal'
  | 'toggleEditor'
  | 'globalVoice'
  | 'prevTab'
  | 'nextTab'
  | 'closeTab'
  | 'splitPane'
  | 'historyBack'
  | 'historyForward';

const KEY_NAMES: Record<string, string> = {
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↵': 'Enter',
  Space: ' ',
};

/** Parse a default written in glyphs. Modifier glyphs first, then one key. */
export function parseChord(glyphs: string): Chord {
  const chord: Chord = { mod: false, ctrl: false, alt: false, shift: false };
  let i = 0;
  for (; i < glyphs.length; i += 1) {
    const ch = glyphs.charAt(i);
    if (ch === '⌘') chord.mod = true;
    else if (ch === '⌃') chord.ctrl = true;
    else if (ch === '⌥') chord.alt = true;
    else if (ch === '⇧') chord.shift = true;
    else break;
  }
  const rest = glyphs.slice(i);
  chord.key = KEY_NAMES[rest] ?? rest;
  if (chord.key === '?') delete chord.shift;
  return chord;
}

export interface ActionDef {
  id: ActionId;
  /** The words the Shortcuts page and cheat-sheet use for it. */
  label: string;
  default: Chord;
}

const def = (id: ActionId, label: string, glyphs: string): ActionDef => ({
  id,
  label,
  default: parseChord(glyphs),
});

export const ACTIONS: ActionDef[] = [
  def('cheatSheet', 'Open keyboard cheat-sheet', '⌘?'),
  def('search', 'Focus search', '⌘K'),
  def('searchFind', 'Focus the page search', '⌘F'),
  def('toggleSidebar', 'Toggle sidebar', '⌘/'),
  def('newChat', 'New chat', '⌘N'),
  def('newChatPicker', 'New chat with folder picker', '⌘⇧N'),
  def('prevChat', 'Previous chat', '⌘↑'),
  def('nextChat', 'Next chat', '⌘↓'),
  def('prevFolder', 'Previous folder section', '⌘⇧↑'),
  def('nextFolder', 'Next folder section', '⌘⇧↓'),
  def('historyBack', 'Back through the navigation history', '⌘←'),
  def('historyForward', 'Forward through the navigation history', '⌘→'),
  def('jumpManager', 'Jump to Manager', '⌘1'),
  def('toggleChannels', 'Toggle Channels', '⌘2'),
  def('jumpUnread', 'Jump to oldest unread chat', '⌘J'),
  def('archiveCurrent', 'Archive current chat', '⌘⌥A'),
  def('toggleArchived', 'Toggle archived view', '⌘⇧A'),
  def('fileBrowser', 'Open file browser', "⌘⇧'"),
  def('diffViewer', 'Open diff for last edit', "⌘'"),
  def('toggleEditor', 'Toggle editor rail', '⌥E'),
  def('toggleTerminal', 'Toggle terminal', '⌃`'),
  def('closeTab', 'Close tab', '⌘W'),
  def('prevTab', 'Previous tab', '⌘⌥←'),
  def('nextTab', 'Next tab', '⌘⌥→'),
  def('splitPane', 'Split pane', '⌘\\'),
  def('filePicker', 'File picker (project-wide)', '⌘P'),
  def('searchInFiles', 'Search in files', '⌘⇧F'),
  def('globalVoice', 'Voice note to Manager', '⌃Space'),
];

const BY_ID = new Map<ActionId, ActionDef>(ACTIONS.map((a) => [a.id, a]));

export function actionDef(id: ActionId): ActionDef {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown shortcut action: ${id}`);
  return found;
}

export type Overrides = Partial<Record<ActionId, Chord>>;

export function chordFor(id: ActionId, overrides: Overrides): Chord {
  return overrides[id] ?? actionDef(id).default;
}

const SYMBOL_CODES: Record<string, string> = {
  "'": 'Quote',
  '"': 'Quote',
  '\\': 'Backslash',
  '/': 'Slash',
  '`': 'Backquote',
  ' ': 'Space',
};

function keyMatches(e: KeyboardEvent, key: string): boolean {
  if (e.key.toLowerCase() === key.toLowerCase()) return true;
  if (key === "'" && e.key === '"') return true;
  // The physical key, for the cases where a modifier changes what `key` reports
  // (⌥A is `å` on macOS, ⇧' is `"`).
  const code = /^[a-z]$/i.test(key)
    ? `Key${key.toUpperCase()}`
    : /^[0-9]$/.test(key)
      ? `Digit${key}`
      : SYMBOL_CODES[key];
  return code !== undefined && e.code === code;
}

export function matchesChord(e: KeyboardEvent, chord: Chord): boolean {
  if (chord.mod) {
    if (!(e.metaKey || e.ctrlKey)) return false;
  } else if (chord.ctrl) {
    if (!e.ctrlKey || e.metaKey) return false;
  } else if (e.metaKey || e.ctrlKey) {
    return false;
  }
  if (e.altKey !== chord.alt) return false;
  if (chord.shift !== undefined && e.shiftKey !== chord.shift) return false;
  if (chord.code !== undefined) return e.code === chord.code;
  return chord.key !== undefined && keyMatches(e, chord.key);
}

export function matchesAction(e: KeyboardEvent, id: ActionId, overrides: Overrides): boolean {
  return matchesChord(e, chordFor(id, overrides));
}

/** The chord a keydown spells, for recording; null while only modifiers are
 *  held, or when nothing but Shift is (a bare letter must stay typeable). */
export function recordChord(e: KeyboardEvent, mac: boolean = isMacKeyboard()): Chord | null {
  if (e.code === '' || MODIFIER_CODES.has(e.code)) return null;
  if (!(e.metaKey || e.ctrlKey || e.altKey)) return null;
  // On a Mac, Ctrl without ⌘ is its own modifier (⌃Space); elsewhere Ctrl is the
  // platform modifier.
  const ctrlOnly = mac && e.ctrlKey && !e.metaKey;
  return {
    mod: !ctrlOnly && (e.metaKey || e.ctrlKey),
    ctrl: ctrlOnly,
    alt: e.altKey,
    shift: e.shiftKey,
    code: e.code,
  };
}

const KEY_GLYPHS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↵',
  ' ': 'Space',
};

/** The chord in macOS glyphs (`⌘⇧N`); `shortcutLabel` redraws it per keyboard. */
export function chordToGlyphs(chord: Chord): string {
  const key =
    chord.code !== undefined
      ? chordKeyGlyph(chord.code)
      : (KEY_GLYPHS[chord.key ?? ''] ?? (chord.key ?? '').toUpperCase());
  return `${chord.mod ? '⌘' : ''}${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${key}`;
}

export function actionGlyphs(id: ActionId, overrides: Overrides): string {
  return chordToGlyphs(chordFor(id, overrides));
}

export function sameChord(a: Chord, b: Chord): boolean {
  return chordToGlyphs(a) === chordToGlyphs(b) && a.shift === b.shift;
}

const STORAGE_KEY = 'patch.shortcuts.overrides';

function isChord(v: unknown): v is Chord {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c['mod'] === 'boolean' &&
    typeof c['ctrl'] === 'boolean' &&
    typeof c['alt'] === 'boolean' &&
    (c['code'] === undefined || typeof c['code'] === 'string') &&
    (c['key'] === undefined || typeof c['key'] === 'string') &&
    (c['code'] !== undefined || c['key'] !== undefined)
  );
}

export function loadOverrides(): Overrides {
  /* v8 ignore next -- jsdom always defines localStorage. */
  if (typeof localStorage === 'undefined') return {};
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return {};
  // Set but unreadable is not a first run — say so rather than quietly
  // answering to chords nobody chose.
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${STORAGE_KEY} is not a keymap: ${raw}`);
  }
  const out: Overrides = {};
  for (const [id, chord] of Object.entries(parsed)) {
    if (!BY_ID.has(id as ActionId) || !isChord(chord)) {
      throw new Error(`${STORAGE_KEY} has an invalid entry "${id}": ${raw}`);
    }
    out[id as ActionId] = chord;
  }
  return out;
}

export function saveOverrides(overrides: Overrides): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}
