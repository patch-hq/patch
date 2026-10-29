// Global keyboard-shortcut wiring per spec/14 ## Keyboard shortcuts.
//
// In scope for the SPA today:
//   ⌘?   open the keyboard cheat-sheet
//   ⌘K   focus the page's search field (else the sidebar's chat search)
//   ⌘F   focus the page's search field (falls through to the browser's find
//        bar on a page that has no search field of its own)
//   ⌘/   toggle sidebar
//   ⌘N   new chat (FAB)
//   ⌘↑/⌘↓  prev/next chat in sidebar
//   ⌘←/⌘→  back/forward through nav history (handled by NavHistoryControls,
//          not this file — it owns the stack the chord walks)
//   ⌘1   jump to Manager
//   ⌘2   toggle Channels (expand/collapse)
//   ⌘⌥A  archive current chat (⌘A is left to the OS: select all)
//   ⌘⇧A  toggle archived view
//   ⌘P   open the editor rail's file picker
//   ⌘'   open the diff editor on the last agent edit
//   ⌘↵   send, same as ↵, in the composer (never interrupts a running turn)
//   ⌘↵   commit the field being typed in, everywhere else (lib/submitChord.ts)
//   ⌘⇧D  dictate (hold to talk; a tap opens a sustained session) — the
//        chord is set per host in Settings → Voice (lib/dictateChord.ts)
//   ⌃Space  global voice to Manager (window-level handler)
//
// Component-local handlers (not registered here) live next to their
// owning components:
//   - ↵ / Esc on the IncomingCallBanner.
//   - 1 / 2 / 3 inside a focused permission card.

import { useEffect, useRef } from 'react';

import { useUiStore } from '../stores/uiStore.js';
import { matchesChord } from './dictateChord.js';
import { actionGlyphs, matchesAction, type ActionId } from './keymap.js';
import { isMacKeyboard, type KeyboardPlatformProbe } from './sendChord.js';
import { isEditorFindTarget, type SearchChord } from './searchTarget.js';

export interface ShortcutHandlers {
  /** ⌘K / ⌘F — focus the page's search field. Returns false when the page has
   *  none, which is what lets ⌘F leave the chord to the browser. `chord` says
   *  which: only ⌘K may land on the sidebar's global chat search. */
  onSearch(chord: SearchChord): boolean;
  onNewChat(): void;
  /** ⌘⇧N — new chat with the folder picker focused (spec/14 keyboard table). */
  onNewChatPicker(): void;
  /** ⌘J — jump to the oldest unread chat (spec/14 keyboard table). */
  onJumpOldestUnread(): void;
  /** ⌘⇧↑ — jump to the previous folder section in the sidebar. */
  onPrevFolder(): void;
  /** ⌘⇧↓ — jump to the next folder section in the sidebar. */
  onNextFolder(): void;
  onJumpManager(): void;
  onArchiveCurrent(): void;
  onFilePicker(): void;
  onDiffViewer(): void;
  /**
   * ⌘⇧' opens the file browser — the chat's own folder when a chat is
   * focused, or the host-wide browser when there isn't one (spec/14 § File
   * browser — open without a chat).
   */
  onFileBrowser(): void;
  /** ⌘⇧F — search in files under the host browser's current folder (spec/14 § File browser). */
  onSearchInFiles(): void;
  /** `at`: the keydown's `timeStamp`, the clock every hold is measured on. */
  onVoiceHoldStart(at: number): void;
  /** `heldMs` is how long the chord was down — a tap and a press-and-hold are
   *  different gestures (spec/07 ## Voice-input modes — mode 1). */
  onVoiceHoldEnd(heldMs: number, at: number): void;
  onGlobalVoiceStart(): void;
  onGlobalVoiceEnd(heldMs: number): void;
  onToggleSidebar(): void;
  onToggleChannels(): void;
  onToggleArchived(): void;
  onPrevChat(): void;
  onNextChat(): void;
  onCheatSheet(): void;
  /** Group 20 fix DX-6: ⌥E toggles the editor rail. */
  onToggleEditor(): void;
  /** ⌃` toggles the chat's terminal drawer (spec/14 § Terminal). */
  onToggleTerminal(): void;
  /** ⌘W — close the active pane's active tab (spec/14 § Panes and tabs). */
  onCloseTab(): void;
  /** ⌘⌥←/→ — switch tabs within the active pane. */
  onPrevTab(): void;
  onNextTab(): void;
  /** ⌘\ — split the active pane, moving its active tab into a new pane
   *  beside it. */
  onSplitPane(): void;
}

/** What each modifier glyph is called on a keyboard that does not print it. */
const MODIFIER_WORDS: Record<string, string> = {
  '⌘': 'Ctrl',
  '⌃': 'Ctrl',
  '⌥': 'Alt',
  '⇧': 'Shift',
};

/** Glyph keys that have a name worth reading when the modifiers are words. */
const KEY_WORDS: Record<string, string> = {
  '↵': 'Enter',
  '↑': 'Up',
  '↓': 'Down',
  '←': 'Left',
  '→': 'Right',
};

/**
 * The chord as this keyboard should see it (spec/14 § Discoverability).
 *
 * A chord is written once, in macOS glyphs — the notation `SHORTCUT_TABLE` and
 * spec/14's table use (`⌘⌥A`, `⌥E`, `⌃\``) — and every surface that draws one
 * comes through here, so no call site spells the glyphs out for itself and none
 * of them can disagree about what a chord is called.
 *
 * A Mac gets the glyphs verbatim, because they are printed on its keys. Nothing
 * else does: `⌃` and `⌥` are Apple's glyphs for keys a PC keyboard labels Ctrl
 * and Alt, so swapping one glyph for another there still names a key the user
 * cannot find. The modifiers become their own key's words instead, joined with
 * `+` the way every other app on those platforms writes a chord.
 */
export function shortcutLabel(chord: string, probe?: KeyboardPlatformProbe | null): string {
  if (isMacKeyboard(probe)) return chord;
  const mods: string[] = [];
  let key = '';
  for (const ch of chord) {
    if (/\s/.test(ch)) continue;
    const word = MODIFIER_WORDS[ch];
    // A modifier already named (⌘ and ⌃ both read Ctrl off-Mac) is not repeated.
    if (word !== undefined) {
      if (!mods.includes(word)) mods.push(word);
      continue;
    }
    key += KEY_WORDS[ch] ?? ch;
  }
  return [...mods, key].filter((part) => part !== '').join('+');
}

/**
 * The tooltip for a control that has a shortcut: its name, then the chord.
 *
 * `name` obeys spec/14 § Copy — no helper text (a few words naming the control,
 * never a sentence), and the chord is the discoverability the spec asks for on
 * top of it.
 */
export function shortcutTitle(
  name: string,
  chord: string,
  probe?: KeyboardPlatformProbe | null,
): string {
  return `${name} (${shortcutLabel(chord, probe)})`;
}

/**
 * A shortcut's scope, host-checkable where this file itself dispatches the
 * chord (spec/14 § Discoverability — "each shortcut declares its scope in
 * code... the handler enforces it"):
 *
 *   - `anywhere`  — fires regardless of route or focus (the app-wide chords:
 *     search, new chat, sidebar, cheat-sheet, file picker).
 *   - `chat-view` — fires only while a chat view is showing (`/`, `/chats/new`,
 *     `/chats/:id` — NOT Jobs, the job editor, Settings, or a popped-out
 *     window), and only when no text field owns the
 *     keystroke — a text field, the composer included, keeps its native
 *     keys (⌘↑/⌘↓ move the caret to the start/end of the text).
 *   - `{ other: '<label>' }` — scope this file does not itself check, because
 *     the chord is owned by a different component that is already scoped by
 *     its own mount/focus/open state (a banner, the composer, a permission
 *     card) or — for the editor's own chords — a scope step 2 enforces.
 */
export type ShortcutScope =
  | { kind: 'anywhere' }
  | { kind: 'chat-view' }
  | { kind: 'other'; label: string };

const ANYWHERE: ShortcutScope = { kind: 'anywhere' };
const CHAT_VIEW: ShortcutScope = { kind: 'chat-view' };
const other = (label: string): ShortcutScope => ({ kind: 'other', label });

/** The label the cheat-sheet renders — the ONE place `kind` becomes copy, so
 *  the table can never say something the handler doesn't do. */
export function shortcutScopeLabel(scope: ShortcutScope): string {
  switch (scope.kind) {
    case 'anywhere':
      return 'Anywhere';
    case 'chat-view':
      return 'Chat view';
    case 'other':
      return scope.label;
  }
}

export interface ShortcutEntry {
  keys: string;
  action: string;
  scope: ShortcutScope;
  /** The rebindable actions this row draws, in order; `keys` is the default. */
  ids?: ActionId[];
  /** The row's keys are the rebindable dictate chord, not `keys`. */
  dictate?: true;
}

/** Source-of-truth list rendered by the cheat-sheet modal. */
export const SHORTCUT_TABLE: ShortcutEntry[] = [
  { keys: '⌘ ?', ids: ['cheatSheet'], action: 'Open keyboard cheat-sheet', scope: ANYWHERE },
  { keys: '⌘ K', ids: ['search'], action: 'Focus search', scope: ANYWHERE },
  {
    keys: '⌘ F',
    ids: ['searchFind'],
    action: 'Focus search',
    scope: other('Page with a search field'),
  },
  { keys: '⌘ /', ids: ['toggleSidebar'], action: 'Toggle sidebar', scope: ANYWHERE },
  { keys: '⌘ N', ids: ['newChat'], action: 'New chat', scope: ANYWHERE },
  { keys: '⌘ ⇧ N', ids: ['newChatPicker'], action: 'New chat with folder picker', scope: ANYWHERE },
  {
    keys: '⌘ ↑ / ⌘ ↓',
    ids: ['prevChat', 'nextChat'],
    action: 'Prev / next chat',
    scope: CHAT_VIEW,
  },
  {
    keys: '⌘ ⇧ ↑ / ⌘ ⇧ ↓',
    ids: ['prevFolder', 'nextFolder'],
    action: 'Prev / next folder section',
    scope: CHAT_VIEW,
  },
  {
    keys: '⌘ ← / ⌘ →',
    ids: ['historyBack', 'historyForward'],
    action: 'Back / Forward through the navigation history',
    // Enforced by NavHistoryControls itself (mounted only on a chat view) —
    // not by this file's handler.
    scope: other('Chat panel shown, no field focused'),
  },
  { keys: '⌘ 1', ids: ['jumpManager'], action: 'Jump to Manager', scope: CHAT_VIEW },
  { keys: '⌘ 2', ids: ['toggleChannels'], action: 'Toggle Channels', scope: CHAT_VIEW },
  { keys: '⌘ J', ids: ['jumpUnread'], action: 'Jump to oldest unread chat', scope: CHAT_VIEW },
  { keys: '⌘ ⌥ A', ids: ['archiveCurrent'], action: 'Archive current chat', scope: CHAT_VIEW },
  { keys: '⌘ ⇧ A', ids: ['toggleArchived'], action: 'Toggle archived view', scope: CHAT_VIEW },
  { keys: '⌘ ⇧ E', action: 'Toggle fullscreen editor', scope: other('Editor open') },
  { keys: "⌘ ⇧ '", ids: ['fileBrowser'], action: 'Open file browser', scope: ANYWHERE },
  { keys: 'Esc', action: 'Exit fullscreen / cancel modal', scope: ANYWHERE },
  {
    keys: '⌥ E',
    ids: ['toggleEditor'],
    action: 'Toggle editor rail',
    scope: other('Composer focused'),
  },
  {
    keys: "⌘ '",
    ids: ['diffViewer'],
    action: 'Open diff for last edit',
    scope: other('Chat focused'),
  },
  { keys: '⌃ `', ids: ['toggleTerminal'], action: 'Toggle terminal', scope: other('Chat focused') },
  { keys: '⌘ W', ids: ['closeTab'], action: 'Close tab', scope: ANYWHERE },
  {
    keys: '⌘ ⌥ ← / ⌘ ⌥ →',
    ids: ['prevTab', 'nextTab'],
    action: 'Previous / next tab',
    scope: CHAT_VIEW,
  },
  { keys: '⌘ \\', ids: ['splitPane'], action: 'Split pane', scope: CHAT_VIEW },
  { keys: '⌘ P', ids: ['filePicker'], action: 'File picker (project-wide)', scope: ANYWHERE },
  {
    keys: '⌘ ⇧ F',
    ids: ['searchInFiles'],
    action: 'Search in files',
    scope: other('File browser open'),
  },
  {
    keys: '⌃ G',
    action: 'Go to line',
    // Monaco's own built-in action (`editor.action.gotoLine`) — not bound by
    // this file's handler, which is why it is listed here rather than wired
    // into `handleKeyDown` below (spec/14 § Keyboard shortcuts).
    scope: other('Editor showing a file'),
  },
  { keys: '⌘ E', action: 'Recent files', scope: other('File browser open') },
  { keys: '⌘ S', action: 'Save the open file', scope: other('Editor showing a file') },
  // The rule the app used to state only for the composer (spec/14 § Keyboard
  // shortcuts): wherever a field has a save action, the chord runs it.
  {
    keys: '⌘ ↵',
    action: 'Save / commit the field',
    scope: other('Editable field with a save action'),
  },
  // The composer keys the user reaches for constantly. `↵` and `⇧↵` were both
  // missing (the user, `patch/todo.md` — "nothing tells you enter sends. placeholder
  // + cheatsheet both miss it") — the cheat-sheet listed only the ⌘ variant, so
  // the PRIMARY send key and the newline key appeared nowhere in the UI at all.
  { keys: '↵', action: 'Send composer (queues while running)', scope: other('Composer focused') },
  { keys: '⇧ ↵', action: 'Newline in composer', scope: other('Composer focused') },
  { keys: 'Esc', action: 'Stop the running turn', scope: other('Composer focused') },
  {
    keys: '/',
    action: 'Skill autocomplete (↑↓ move · ⇥ completes)',
    scope: other('Composer focused'),
  },
  {
    keys: '⌘ ⇧ D',
    action: 'Dictate (hold to talk, tap to keep listening)',
    scope: other('Chat focused'),
    dictate: true,
  },
  {
    keys: '⌃ Space',
    ids: ['globalVoice'],
    action: 'Voice note to Manager (hold to talk, tap to keep listening)',
    scope: other('Menu-bar'),
  },
  { keys: '↵', action: 'Accept incoming call', scope: other('Incoming-call banner') },
  { keys: 'Esc', action: 'Dismiss incoming call', scope: other('Incoming-call banner') },
  {
    keys: '1 / 2 / 3',
    action: 'Approve / approve all outstanding / decline',
    scope: other('Permission card'),
  },
];

/** A "chat view" is `/`, `/chats/new`, or `/chats/:chatId` — not its
 *  editor-window pop-out (`/chats/:chatId/editor-window`), which has no chat
 *  panel to navigate (spec/14 § Discoverability). */
export function isChatViewPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/chats/new' || /^\/chats\/[^/]+$/.test(pathname);
}

/** What the caller currently shows — the one fact `chat-view` scope needs. */
export interface ShortcutScopeState {
  isChatView: boolean;
}

/** An action's chord in macOS glyphs, following the user's override — what a
 *  control's tooltip passes to `shortcutTitle` / `shortcutLabel`. */
export function useActionGlyphs(id: ActionId): string {
  const overrides = useUiStore((st) => st.shortcutOverrides);
  return actionGlyphs(id, overrides);
}

function isTextFieldTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/** Enforces `scope` (spec/14 § Discoverability): `anywhere` always passes;
 *  `chat-view` needs a chat view on screen AND no text field (the composer
 *  included) in the way, so a field keeps its native keys. */
function scopeAllows(scope: ShortcutScope, e: KeyboardEvent, state: ShortcutScopeState): boolean {
  if (scope.kind !== 'chat-view') return true;
  if (!state.isChatView) return false;
  return !isTextFieldTarget(e);
}

export function useShortcuts(handlers: ShortcutHandlers, scope: ShortcutScopeState): void {
  // Null when the chord is up; otherwise the moment it went down, so the
  // release can report how long it was held. In refs, not the effect: the
  // effect re-runs whenever `handlers` is a new object (every render of a
  // caller passing it inline), and a hold in progress must survive that.
  const dictateHeldRef = useRef<{ at: number | null; code: string }>({ at: null, code: '' });
  const ctrlSpaceHeldRef = useRef<{ at: number | null; code: string }>({ at: null, code: '' });
  useEffect(() => {
    const dictateHeld = dictateHeldRef.current;
    const ctrlSpaceHeld = ctrlSpaceHeldRef.current;

    function down(e: KeyboardEvent): void {
      // First, so a chord the user picked is never shadowed by a built-in one.
      const dictate = useUiStore.getState().dictateChord;
      if (matchesChord(e, dictate)) {
        e.preventDefault();
        if (dictateHeld.at !== null) return; // key repeat
        // The event's own time, not the handler's: a page busy opening the mic
        // runs the keyup handler late, and timing from the handlers turned a
        // quick tap into a hold. The browser stamps the event when it arrives.
        dictateHeld.at = e.timeStamp;
        dictateHeld.code = dictate.code;
        handlers.onVoiceHoldStart(e.timeStamp);
        return;
      }
      const overrides = useUiStore.getState().shortcutOverrides;
      const is = (id: ActionId): boolean => matchesAction(e, id, overrides);
      if (is('cheatSheet')) {
        e.preventDefault();
        handlers.onCheatSheet();
        return;
      }
      if (is('search')) {
        e.preventDefault();
        handlers.onSearch('k');
        return;
      }
      // ⌘F is a reserved OS chord (spec/14 § Reserved OS chords), carved out
      // ONLY for a page that has its own search field. So the preventDefault is
      // conditional on `onSearch()` reporting that it actually took focus: with
      // no search field on the page the chord is untouched and the browser's
      // own find bar opens, exactly as before.
      if (is('searchFind')) {
        if (isEditorFindTarget(e)) return;
        if (handlers.onSearch('f')) e.preventDefault();
        return;
      }
      if (is('searchInFiles')) {
        e.preventDefault();
        handlers.onSearchInFiles();
        return;
      }
      if (is('toggleSidebar')) {
        e.preventDefault();
        handlers.onToggleSidebar();
        return;
      }
      if (is('newChatPicker')) {
        e.preventDefault();
        handlers.onNewChatPicker();
        return;
      }
      if (is('newChat')) {
        e.preventDefault();
        handlers.onNewChat();
        return;
      }
      // Chat-list chords are `chat-view` scoped (spec/14 § Discoverability): a
      // text field keeps them.
      if (is('prevFolder')) {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onPrevFolder();
        return;
      }
      if (is('prevChat')) {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onPrevChat();
        return;
      }
      if (is('nextFolder')) {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onNextFolder();
        return;
      }
      if (is('nextChat')) {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onNextChat();
        return;
      }
      if (is('jumpManager')) {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onJumpManager();
        return;
      }
      if (is('toggleChannels')) {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onToggleChannels();
        return;
      }
      if (is('jumpUnread')) {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onJumpOldestUnread();
        return;
      }
      if (is('toggleArchived')) {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onToggleArchived();
        return;
      }
      // Archive lives on ⌘⌥A, NOT ⌘A (spec/14 § Reserved OS chords). ⌘A is
      // select-all everywhere — including over the transcript, where selecting
      // the whole conversation to copy it is exactly what the user means. The
      // default never matches a bare ⌘A, in or out of a text field.
      if (is('archiveCurrent')) {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onArchiveCurrent();
        return;
      }
      if (is('filePicker')) {
        e.preventDefault();
        handlers.onFilePicker();
        return;
      }
      // ⌘⇧' (file browser) is checked before ⌘' (last-edit diff): both default
      // to the same physical key and differ only in shift.
      if (is('fileBrowser')) {
        e.preventDefault();
        handlers.onFileBrowser();
        return;
      }
      if (is('diffViewer')) {
        e.preventDefault();
        handlers.onDiffViewer();
        return;
      }
      // ⌃` — the terminal drawer, on the key every terminal-bearing app uses.
      // Checked before the ⌃Space voice hold so neither swallows the other.
      if (is('toggleTerminal')) {
        e.preventDefault();
        handlers.onToggleTerminal();
        return;
      }
      if (is('toggleEditor')) {
        e.preventDefault();
        handlers.onToggleEditor();
        return;
      }
      if (is('globalVoice') && ctrlSpaceHeld.at === null) {
        e.preventDefault();
        ctrlSpaceHeld.at = e.timeStamp;
        ctrlSpaceHeld.code = e.code;
        handlers.onGlobalVoiceStart();
        return;
      }
      // Panes and tabs (spec/14 § Keyboard shortcuts). Scoped to a chat view,
      // but — unlike the chat-list chords above — NOT ceded to a focused text
      // field: `scopeAllows`'s text-field exception exists so a field keeps
      // its native editing keys, and none of these default chords collide with
      // one. Going through it anyway would mean never firing in the ordinary
      // case, since opening a chat puts the cursor straight into the composer
      // (spec/14 § Composer).
      if (is('prevTab')) {
        if (!scope.isChatView) return;
        e.preventDefault();
        handlers.onPrevTab();
        return;
      }
      if (is('nextTab')) {
        if (!scope.isChatView) return;
        e.preventDefault();
        handlers.onNextTab();
        return;
      }
      // ⌘W is claimed unconditionally — not even gated on `isChatView` — like
      // ⌘P/⌘K/⌘/ above: never left to fall through to the OS, which would
      // close the real browser tab/window rather than the app's own one.
      if (is('closeTab')) {
        e.preventDefault();
        handlers.onCloseTab();
        return;
      }
      if (is('splitPane')) {
        if (!scope.isChatView) return;
        e.preventDefault();
        handlers.onSplitPane();
        return;
      }
    }

    function up(e: KeyboardEvent): void {
      // macOS suppresses the keyup for a character key while ⌘ is held, so the
      // modifier's own release has to count as the end of the chord too —
      // otherwise a dictation is left recording with no release to commit it.
      const modUp = e.key === 'Meta' || e.key === 'Control';
      if ((e.code === dictateHeld.code || modUp) && dictateHeld.at !== null) {
        const held = e.timeStamp - dictateHeld.at;
        dictateHeld.at = null;
        handlers.onVoiceHoldEnd(held, e.timeStamp);
      }
      if ((e.code === ctrlSpaceHeld.code || modUp) && ctrlSpaceHeld.at !== null) {
        const held = e.timeStamp - ctrlSpaceHeld.at;
        ctrlSpaceHeld.at = null;
        handlers.onGlobalVoiceEnd(held);
      }
    }

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [handlers, scope.isChatView]);
}
