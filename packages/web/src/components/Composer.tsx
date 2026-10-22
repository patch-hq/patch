// Composer — multi-line input. ↵ (or ⌘↵ / Ctrl↵) sends; while a turn is
// running a send queues behind it and never interrupts it (spec/04 § Message
// queueing). Disabled while WS is offline (per spec/14 ## Offline / error
// states).
//
// Stacked layout (per spec/14 § Main panel layout): the textarea spans the full
// chat width on its own row, with the action buttons on a row BELOW it — utility
// buttons (attach | mic | call) grouped left, send pushed to the far right. Every
// action button shares ONE icon size (spec/14 § Composer). The mic (and ⌘⇧D, via
// lib/composerMic.ts) dictates into the input: grey live words while talking,
// a second press keeps them, send sends them. On the new-chat screen it starts
// a voice note instead. Call (moved here from the chat header, the user, 30 Sep
// 2026) starts a sustained voice call on this chat; on a not-yet-spawned chat
// it creates the chat first via `resolveChatId`, the same create-then-act path
// an attachment with no chat yet already uses.
//
// The editor/diff entry-point does NOT live on the composer row (C2 — desktop
// review 2026-07-14): a pencil next to send/attach read as a message tool but
// opened the Monaco diff rail, which was repeatedly confusing. The editor is now
// reachable from the chat header's Editor icon (merged file-browser/diff
// control) and its `⋯` overflow menu. The screen-share/screenshot button was
// removed entirely (C3) — it was unclear and error-prone; paste-image (⌘V) and
// the attach paperclip cover attaching visuals.
//
// Attach is a SINGLE paperclip on web/desktop: one OS file dialog that accepts
// images AND any file (spec/14 § Composer). (Mobile keeps two — a photo library
// and a document picker are genuinely different pickers there.) Typing `/` at the
// start opens a skill autocomplete sourced from the chat's folder (spec/14 §
// Composer — skill autocomplete).

import { LONG_PASTE_CHARS, pastedTextName } from '../lib/pastedText';
import type { JSX, ReactNode, Ref } from 'react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ContextRing } from './ContextRing.js';
import { ChatModelControl } from './ChatModelControl.js';
import {
  Mic,
  ListPlus,
  Send,
  Square,
  Paperclip,
  PenLine,
  Phone,
  FileText,
  Pencil,
  AudioLines,
  Clock,
  Zap,
} from 'lucide-react';
import { endMeeting } from '../lib/meetingControl.js';
import { beginMeeting, maybeIntroduceMeetings } from '../lib/meetingSetup.js';
import { MeetingSetupPopover } from './MeetingSetup.js';
import { isMeetingOpen, useMeetingStore } from '../stores/meetingStore.js';
import { EffortControl } from './EffortControl.js';
import { CloseIcon } from './icons.js';
import { joinQuotes, splitQuotes } from '../lib/composerQuotes.js';
import { ImageAnnotator } from './ImageAnnotator.js';
import { ImageLightbox } from './ImageLightbox.js';
import { SkillPreviewPanel } from './SkillPreviewPanel.js';
import type { PermissionMode } from '@patch/wire';
import {
  permissionModesFor,
  providerBuiltinCommands,
  providerDescriptor,
  providerForModel,
  SPECIAL_THREAD_IDS,
} from '@patch/wire';
import { usePresenceStore } from '../stores/presenceStore.js';
import { providerConnectedForModel, usePreferencesStore } from '../stores/preferencesStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';
import {
  NO_ATTACHMENTS,
  useComposerAttachmentStore,
  type PendingAttachment,
} from '../stores/composerAttachmentStore.js';
import { getActiveWs } from '../api/ws.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import {
  sendVoiceNote,
  cancelVoiceNote,
  releaseVoiceNoteHold,
  startVoiceCall,
  endVoiceCall,
  TAP_THRESHOLD_MS,
} from '../lib/voiceController.js';
import {
  startRecording,
  type VoiceRecording,
  type VoiceRecorderDeps,
} from '../lib/voiceRecorder.js';
import { startDictationPreview, type DictationPreview } from '../lib/dictationPreview.js';
import { registerComposerMic } from '../lib/composerMic.js';
import { startDictationMode, type DictationMode } from '../lib/dictationMode.js';
import type { OutgoingFile } from '../lib/sendQueue.js';
import { ContextMenu, useContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { getLastUsedSkill, setLastUsedSkill, orderSkillsByLastUsed } from '../lib/lastUsedSkill.js';
import { rankByQuery } from '../lib/skillMatch.js';
import {
  activeSlashToken,
  chipEndingAt,
  findChipTokens,
  spliceCompletion,
} from '../lib/skillToken.js';
import { permissionModeLabel } from '../lib/permissionModeLabel.js';
import { GOAL_COMMAND_NAME, GOAL_COMMAND_DESCRIPTION } from '../lib/goalCommand.js';
import { CLEAR_COMMAND_NAME, CLEAR_COMMAND_DESCRIPTION } from '../lib/clearCommand.js';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';
import { isSubmitChord } from '../lib/submitChord.js';
import { shortcutLabel, shortcutTitle } from '../lib/shortcuts.js';
import { chordGlyphs } from '../lib/dictateChord.js';
import { computeTooltipPosition, type TooltipPosition } from '../lib/tooltipPosition.js';
import { api } from '../api/rest.js';
import { failed } from '../lib/errorCopy.js';

/** One glyph size across the action buttons so they read as a matched set and
 *  the mic/send are optically centred against their siblings (spec/14 § Composer). */
const ICON_SIZE = 18;

/** Height cap for the auto-growing composer input, as a fraction of the window
 *  height — MUST match the CSS `max-height` (30vh) on `.composer-input`. Under
 *  this the field expands/contracts to fit with NO scrollbar; only once content
 *  exceeds the cap does it scroll internally, so a long paste can't push the
 *  chat off-screen (spec/14 § Composer). */
const MAX_INPUT_HEIGHT_FRACTION = 0.3;
const maxInputHeight = (): number => Math.round(window.innerHeight * MAX_INPUT_HEIGHT_FRACTION);

/**
 * The modes spec/02 § Permission mode names, in the order they are shown.
 *
 * The value is passed through unchanged to the agent SDK's own
 * `permissionMode`, so the label is the id's OWN WORDS, cased and spaced for
 * reading (`permissionModeLabel`) — never a friendlier synonym, which would
 * mean the user picks one thing and the model is told another (spec/14 §
 * Composer — Approval mode).
 */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'auto',
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
];

function kindForFile(file: File): 'image' | 'file' {
  return file.type.startsWith('image/') ? 'image' : 'file';
}

/** The chip a hover/tap is currently showing a preview for (spec/14 §
 *  Skill autocomplete). `rect` is the chip's own trigger geometry, taken once
 *  when the preview opens — enough for `computeTooltipPosition` to place it. */
interface ChipPreviewState {
  name: string;
  isBuiltin: boolean;
  rect: { top: number; left: number; bottom: number; right: number; width: number; height: number };
}

/** Give a `File` pulled out of a dropped folder a name that carries its path
 *  (e.g. `notes/todo.txt`) — `File` names are otherwise just the basename, so
 *  a folder full of same-named files would collapse into one chip and the
 *  agent would have no way to tell which is which. Zips need none of this:
 *  a dropped `.zip` already arrives as a single flat `File` (its listing is
 *  never expanded), so `kindForFile` handles it like any other attachment. */
function withRelativeName(file: File, relativePath: string): File {
  if (relativePath === file.name) return file;
  return new File([file], relativePath, { type: file.type, lastModified: file.lastModified });
}

/** Depth-first walk of a dropped `FileSystemEntry` (file or directory),
 *  resolving to every `File` underneath it with `prefix` (the path from the
 *  drop root) folded into its name. `webkitGetAsEntry` is what makes a
 *  dropped FOLDER enumerable at all — a bare `DataTransfer.files` list drops
 *  directory entries with no bytes to read. `readEntries` only ever returns
 *  up to 100 entries per call and must be re-called until it returns empty
 *  (the DOM directory-reader contract), hence the `readAll` loop below. */
function collectEntryFiles(entry: FileSystemEntry, prefix: string): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as FileSystemFileEntry).file(
        (file) => resolve([withRelativeName(file, `${prefix}${file.name}`)]),
        reject,
      );
    });
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const readAll = (): Promise<FileSystemEntry[]> =>
      new Promise((resolve, reject) => {
        const acc: FileSystemEntry[] = [];
        const readBatch = () => {
          reader.readEntries((batch) => {
            if (batch.length === 0) {
              resolve(acc);
              return;
            }
            acc.push(...batch);
            readBatch();
          }, reject);
        };
        readBatch();
      });
    return readAll().then((entries) =>
      Promise.all(entries.map((e) => collectEntryFiles(e, `${prefix}${entry.name}/`))).then(
        (nested) => nested.flat(),
      ),
    );
  }
  return Promise.resolve([]);
}

/** Every `File` a drop carries, folders walked recursively (spec/14 §
 *  Composer — drag-and-drop). `DataTransferItem.webkitGetAsEntry()` is the
 *  only way to tell a dropped folder from a dropped file and to read what's
 *  inside it; where it's unavailable (or every item resolves to nothing —
 *  e.g. a browser that doesn't implement it) this falls back to the flat
 *  `dataTransfer.files` list, which still carries plain files dropped
 *  straight in (just not folder contents). */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null);
  if (entries.length > 0) {
    const nested = await Promise.all(entries.map((e) => collectEntryFiles(e, '')));
    return nested.flat();
  }
  return Array.from(dt.files ?? []);
}

/** True while the drag carries files (not e.g. a text selection) — checked
 *  via `types`, which is populated during dragenter/dragover, unlike `files`
 *  (empty until drop). Gates whether this drag is ours to `preventDefault()`
 *  on at all. */
export function dragHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

function makePending(file: File): PendingAttachment {
  const kind = kindForFile(file);
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    name: file.name || (kind === 'image' ? 'image' : 'file'),
    kind,
    ...(kind === 'image' ? { previewUrl: URL.createObjectURL(file) } : {}),
  };
}

export interface ComposerProps {
  chatId: string;
  /** Owner key for unsent attachments, when `chatId` is shared by several
   *  composers (every new-chat draft is "new"). Defaults to `chatId`. */
  attachmentKey?: string;
  /**
   * The host this chat runs on. Credentials and presence are per host (spec/10
   * § Surface in Settings, spec/04 § Spawn), so whether sending is possible is
   * a question about THIS machine. `null` (or '') means the host isn't known
   * yet — a brand-new chat with no folder chosen — and nothing about a
   * credential can be asserted, so sending is not blocked on that ground.
   */
  hostId: string | null;
  selectedModel?: string;
  /**
   * The chat's folder — sources the skill autocomplete (`/` menu). Omitted for
   * surfaces without a folder yet; the menu simply doesn't fetch.
   */
  folder?: string;
  /**
   * Send the trimmed message. May be async and return `false` to signal the
   * send failed (e.g. POST /api/chats 400 folder_not_found): the composer then
   * RESTORES the typed text so the user can retry rather than losing it
   * silently (spec/12 — no silent failures). Returning void/true (or nothing)
   * means the text was accepted and is cleared. `files` are the attached files,
   * NOT yet uploaded: the caller echoes the message at once and uploads them
   * (lib/sendQueue.ts — spec/15 § Composer → Attachments). A `false` return
   * puts the files back in the composer too. The third arg is the real chatId
   * the message goes to (see `resolveChatId`) — callers with a fixed chatId can
   * ignore it.
   */
  onSend(
    message: string,
    files?: OutgoingFile[],
    chatId?: string,
    opts?: { afterTurn?: boolean; interrupt?: boolean },
  ): void | boolean | Promise<void | boolean>;
  /**
   * Resolve the REAL chatId to upload/send to when `chatId` is a placeholder
   * (a brand-new chat that doesn't exist yet — chatId === "new"). Creates the
   * chat and returns its id, or null to abort (error already surfaced). Called
   * before a message WITH attachments is handed over, so its uploads have a
   * real chat to go to
   * (spec/14 § New chat — fixes "attachment upload failed: chat not found:
   * new"). Normal chats don't pass this — `chatId` is already real.
   */
  resolveChatId?(): Promise<string | null>;
  /**
   * Right-click ▸ "Scheduled send": deliver `message` into the chat at `at` (ISO
   * timestamp) through the host's durable one-shot wake. Rejecting shows the
   * error in place and keeps the text. Omitted for surfaces that can't schedule
   * (a not-yet-created chat), which hides the item.
   */
  onScheduleSend?(message: string, at: string): Promise<void>;
  /**
   * Right-click ▸ "Add to todo list": queue the composer's whole input (text and
   * files) as an item on the chat's task list instead of sending it, so it runs
   * as its own turn when the list reaches it. Resolve `false` (error already
   * surfaced) to keep the input in the composer. Omitted where there is no chat
   * to hold a list yet.
   */
  onAddToTodo?(message: string, files: OutgoingFile[]): Promise<boolean>;
  /**
   * When provided, the mic runs in NOTE mode: it fires this to start a voice
   * NOTE (the overlay-driven, fire-a-turn flow) instead of transcribing into the
   * composer. Used by the "voice starts a chat" flow (NewChatRoute), which must
   * create + bind a chat before the note routes in. When ABSENT (the normal
   * chat composer), the mic runs in TRANSCRIBE mode (spec/C1): hold-to-record /
   * click-to-toggle, and the recognised text lands in the input, editable before
   * send — NOT a separate overlay.
   *
   * `typed` is whatever is in the input at the moment the mic is pressed. A note
   * commits its own turn, so without carrying that text along, starting a note
   * would throw away a half-written message; the caller sends it with the note so
   * the turn reads typed-text-then-transcript (spec/07 § 1. Voice note).
   */
  onStartVoiceNote?(chatId: string, gesture: 'ptt' | 'toggle', typed: string): void;
  /**
   * When provided, the Call button hands over to this instead of calling the
   * composer's own chat. Used by NewChatRoute, which must create the chat, wait
   * for it to exist on its host and open it before a call can bind to it.
   */
  onStartCall?(): void;
  /**
   * When provided, the Meeting button hands over to this instead of starting a
   * meeting in the composer's own chat. Used by NewChatRoute, which must create
   * the chat and open it before a meeting can bind to it.
   */
  onStartMeeting?(): void;
  /** Test seam (transcribe mode): inject the mic recorder factory. */
  recorderFactory?(deps?: VoiceRecorderDeps): Promise<VoiceRecording>;
  /** Test seam (transcribe mode): inject the clip→transcript upload call. */
  transcribeClip?(clip: Blob): Promise<{ transcript: string }>;
  /** Test seam (transcribe mode): inject the live-partial preview session. */
  previewFactory?: typeof startDictationPreview;
  /** Test seam (transcribe mode): inject the dictation-mode session factory. */
  dictationModeFactory?: typeof startDictationMode;
  /**
   * Put the cursor in the input on mount (spec/14 § Composer — opening a chat
   * puts the cursor in the composer; § New chat). Skipped while offline, and
   * skipped when something else already owns the cursor.
   */
  autoFocus?: boolean;
  /**
   * Seed the input on mount (spec/14 § New chat drafts): restores a persisted
   * draft's unsent text. Only read once — remount (a new `key`) to re-seed when
   * switching drafts.
   */
  initialValue?: string;
  /**
   * Fired on every input change so a draft can be persisted as the user types
   * (spec/14 § New chat drafts). Debouncing/throttling is the caller's choice.
   */
  onValueChange?(value: string): void;
  /**
   * Put text into the input while the composer is mounted — appended on its
   * own line after anything already typed. Each new `nonce` inserts once. Used
   * for a queued message's edit that lost the race with the message starting
   * (spec/04 ## Message queueing § Edit), so the edit is not lost.
   */
  insert?: { text: string; nonce: number } | null;
  /**
   * spec/20-hooks.md § On the user's message — "Use suggestion" REPLACES
   * whatever is in the input with `text`, unlike `insert` which appends. Each
   * new `nonce` replaces once. The user still sends it themselves.
   */
  replace?: { text: string; nonce: number } | null;
  /**
   * True while the chat is running a turn. Surfaces a Stop control (parity with
   * Claude Code's interrupt) — the user can still type to queue ahead.
   */
  running?: boolean;
  /** Interrupt the in-flight turn (fires chat.stop_request). */
  onStop?(): void;
  /**
   * spec/20-hooks.md § On the user's message — a `POST /api/hooks/check` is
   * in flight for the message about to be sent. Replaces the send button's
   * idle state with "Checking…" (disabled) naming the hook(s) in scope,
   * rather than leaving a send that silently takes longer than usual.
   */
  checking?: boolean;
  /** The hook name(s) a `checking` state is waiting on, for the button's label. */
  checkingHookNames?: string[];
  /** Replaces "Type a message" (a meeting's Note mode writes a note, not a message). */
  placeholder?: string;
  /** Drawn at the start of the input row, before the text (the meeting's Note / Ask switch). */
  leading?: ReactNode;
  /**
   * Edit mode (spec/04 § Branching): this composer edits the text
   * of a message already in the transcript instead of composing a new one. It
   * is the same box — `/` skill menu and chips, dictation, quotes, auto-grow,
   * paste — with the parts that only make sense for a new turn (attachments,
   * call, meeting, approval mode, model, context ring, drafts, stop) left out,
   * and Cancel / Save in place of Send. ⌘↵ saves (bare ↵ is a newline), Esc cancels. `onSave`
   * gets the trimmed text; with `allowEmpty` an empty text is passed through
   * (a queued message's edit to nothing is a remove), without it Save stays
   * disabled until there is text. Seed the text with `initialValue`.
   */
  edit?: { onSave(text: string): void; onCancel(): void; allowEmpty?: boolean };
  /**
   * spec/04 § Branching — this MAIN composer is carrying an earlier user turn
   * back for re-sending (the transcript from that turn down is greyed). Unlike
   * `edit`, every control stays: model, approval mode, attachments, dropdowns.
   * Send forks from the turn via `onSend`; Cancel or Esc calls `onCancel`.
   */
  editingTurn?: { onCancel(): void };
}

/**
 * Imperative surface for a drop zone that lives OUTSIDE the composer's own
 * form (spec/14 § Composer — drag-and-drop covers the whole chat panel, not
 * just the composer strip). The wider zone resolves the drop itself (it needs
 * the same folder-walk as `filesFromDataTransfer`, exported above for that
 * reason) and hands the composer the finished `File[]` — attaching stays the
 * composer's job because that's where `attachments` state lives.
 */
export interface ComposerHandle {
  /** Queue files as pending attachments, unless attaching is currently blocked. */
  attachFiles(files: File[]): void;
  /** Whether a drop right now would be rejected (offline / no credential / mid-upload). */
  isDropBlocked(): boolean;
}

/**
 * Elements that OWN the cursor once they have it. Auto-focus is a courtesy —
 * it must never overwrite a claim like these, because every one of them is
 * either something the user is typing into or something whose own keyboard
 * chords stop working the moment focus leaves it: a text field (including
 * Monaco's hidden input and any search box), an open modal, and the
 * permission / question cards (`.permission`, which the question card also
 * carries), which focus themselves on mount for their `1`/`2`/`3` and
 * arrow-key answers.
 *
 * A sidebar chat row is deliberately NOT on this list. Clicking a row leaves
 * that link focused, and that click IS the navigation the composer's
 * auto-focus exists to answer.
 */
const FOCUS_CLAIMED_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="dialog"]',
  '.permission',
].join(', ');

function focusIsClaimed(): boolean {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  return el.closest(FOCUS_CLAIMED_SELECTOR) !== null;
}

export const Composer = forwardRef(function Composer(
  {
    chatId,
    attachmentKey = chatId,
    hostId,
    folder,
    onSend,
    selectedModel,
    resolveChatId,
    onScheduleSend,
    onAddToTodo,
    onStartVoiceNote,
    onStartCall,
    onStartMeeting,
    recorderFactory,
    transcribeClip,
    previewFactory,
    dictationModeFactory,
    autoFocus = false,
    initialValue,
    onValueChange,
    insert,
    replace,
    running = false,
    onStop,
    checking = false,
    checkingHookNames,
    placeholder: placeholderText = 'Type a message',
    leading,
    edit,
    editingTurn,
  }: ComposerProps,
  ref: Ref<ComposerHandle>,
): JSX.Element {
  const connection = usePresenceStore((s) => s.connection);
  const hostOnline = usePresenceStore((s) => s.hostOnline);
  const offline = connection !== 'connected';
  // Provider accounts are the user's, shared by every host (spec/10), so what
  // gates sending is whether any account is connected for this model, never
  // which machine the chat runs on.
  const storedModel = useChatStore((s) => s.chats[chatId]?.model);
  const accountModel = selectedModel ?? storedModel;
  const claudeDisconnected =
    usePreferencesStore((s) => providerConnectedForModel(s.shared, accountModel)) === false;
  // Text sends stay enabled while the host is offline — they QUEUE and deliver
  // on reconnect (spec/12 + spec/14 § Daemon-offline UX). Only real-time-only
  // audio controls (voice note/call) can't be queued, so they disable with a
  // daemon-offline reason. `offline` (WS link down) still disables voice/attach
  // — there's nothing to upload/stream into.
  const voiceDisabled = offline || !hostOnline;
  // A missing Claude credential is NOT like daemon-offline. Daemon-offline queues
  // the text and delivers it on reconnect, so sending stays enabled; with no
  // credential the turn can never run, so accepting the message would be a lie.
  // Disabling here is what stops "new chat cannot work but doesn't say so".
  // Attach/voice need a live link regardless of chat state (upload-on-send /
  // real-time audio have nothing to queue into).
  const linkOrCredentialBlocked = offline || claudeDisconnected;
  // Sending TEXT into an EXISTING chat also stays enabled while the link is
  // down (Todoist 6hWrcpCQFqXGJpF6) — it queues in-memory and flushes on
  // reconnect, same as daemon-offline (spec/12 § Surface → server disconnect;
  // deliveryTracker already retries regardless of *why* the send failed, see
  // its doSend/onReconnect). A brand-new chat (chatId === "new") is the one
  // exception: spawning it has to validate the folder on a live link, so it
  // is refused up front instead of queued (spec/12 § Host-offline UX).
  const isNewChat = chatId === 'new';
  const sendBlocked = (offline && isNewChat) || claudeDisconnected;
  // The EFFECTIVE approval mode the next turn will use, as the host resolved
  // it and put it on `chat.state` — never re-derived here, since a surface does
  // not hold the host default this was resolved against. `undefined` means the
  // chat does not exist yet (NewChatRoute's placeholder chatId): there is no
  // per-chat setting to write, so the control is not rendered at all.
  const permissionMode = useChatStore((s) => s.chats[chatId]?.permissionMode);
  // Which modes this chat's MODEL can actually run (spec/02 § Permission mode).
  // `auto` needs a model that supports it, and Claude Code silently substitutes
  // `default` where it does not — so offering it on a model that cannot is
  // offering a choice that will not be honoured. The currently-set mode is kept
  // regardless, so a chat already on it can still see what it is on.
  const chatModel = useChatStore((s) => s.chats[chatId]?.model);
  const offeredModes =
    chatModel === undefined || chatModel === null
      ? PERMISSION_MODES
      : permissionModesFor(chatModel);
  // Seed once from a persisted draft (spec/14 § New chat drafts); switching
  // drafts remounts the Composer (new `key`), which re-seeds.
  const [value, setValue] = useState(initialValue ?? '');
  // Latest value, for the dictation commit that lands after an await and must
  // join its transcript onto whatever is in the box by then.
  const valueRef = useRef(value);
  valueRef.current = value;
  // spec/14 § Composer — quotes: leading `> ` blocks of the draft are drawn as
  // cards above the input, and the textarea (with its caret, `/` menu and
  // chips) works on the remaining `body` only.
  const { quotes, body } = useMemo(() => splitQuotes(value), [value]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Where the caret sits, kept in sync so the `/` menu (and chip rendering)
  // can reason about the token the cursor is actually IN, anywhere in the
  // message, not just about the value as a whole (spec/14 § Skill
  // autocomplete). Updated on every change/click/key/select — cheap, and
  // simpler than trying to infer it from `value` alone (`value` alone can't
  // tell "/plant" typed at the end from "/plant" typed at the start of a
  // longer message).
  const [cursorPos, setCursorPos] = useState(0);
  function syncCursor(el: HTMLTextAreaElement): void {
    setCursorPos(el.selectionStart ?? 0);
  }
  // A completion/backspace-chip-removal computes the new caret position
  // itself, but can only apply it once the DOM textarea actually holds the
  // new value — set here and consumed by the layout effect below, right
  // after `value` commits.
  const pendingCursorRef = useRef<number | null>(null);
  // The textarea is driven from `body` by hand rather than via React's `value`
  // prop: a controlled textarea has React rewrite `defaultValue` (a childList
  // mutation) after every keystroke, which makes Chromium end the undo group,
  // so ⌘Z stepped back one character at a time. Only assign when the DOM
  // differs, so typing never touches the value and the undo stack survives.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && el.value !== body) el.value = body;
  }, [body]);
  useLayoutEffect(() => {
    const pos = pendingCursorRef.current;
    if (pos === null) return;
    pendingCursorRef.current = null;
    inputRef.current?.setSelectionRange(pos, pos);
    setCursorPos(pos);
  }, [value]);
  // Persist the draft as the user types. Fire ONLY when `value` changes — the
  // callback is read through a ref so an inline (per-render) `onValueChange`
  // prop doesn't re-run this effect every render (which would loop: persist →
  // store set → re-render → persist). Skip the mount fire (value already equals
  // the seeded draft text — no need to write it straight back).
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;
  const didMountValue = useRef(false);
  useEffect(() => {
    if (!didMountValue.current) {
      didMountValue.current = true;
      return;
    }
    onValueChangeRef.current?.(value);
  }, [value]);
  // spec/14 § Composer — server-owned drafts: while this composer is NOT
  // focused, its visible text stays live-synced to the store, so a draft
  // typed on another surface appears here without needing a blur or a
  // remount first. While focused, the store holds any incoming update back
  // (see `setFocused` — this then fires once blur applies it), so this never
  // fights a keystroke.
  // Subscribed imperatively, not via a hook selector: a selector re-rendered
  // this whole component on every keystroke's own store write.
  // A composer seeded with `initialValue` (a new-chat draft) owns its text from
  // the first render: the mount run of this effect would otherwise overwrite
  // the seed with the (empty) per-chat draft of `chatId`, whenever focus had
  // not landed yet — which wiped a draft opened by "Send to new chat".
  const seededOnMount = useRef(initialValue !== undefined);
  useEffect(() => {
    // An editor owns its text; the chat's unsent-message draft is not its.
    if (edit) return;
    const apply = (): void => {
      if (useComposerDraftStore.getState().focused[chatId]) return;
      const next = useComposerDraftStore.getState().drafts[chatId] ?? '';
      // Our own keystroke's echo: nothing to apply, and a no-op setValue
      // would still cost a render.
      if (next === valueRef.current) return;
      setValue(next);
    };
    if (seededOnMount.current) seededOnMount.current = false;
    else apply();
    let last = useComposerDraftStore.getState().drafts[chatId] ?? '';
    return useComposerDraftStore.subscribe((st) => {
      const next = st.drafts[chatId] ?? '';
      if (next === last) return;
      last = next;
      apply();
    });
  }, [chatId, !!edit]);
  const insertNonce = insert?.nonce;
  const insertText = insert?.text;
  useEffect(() => {
    if (insertNonce === undefined || insertText === undefined) return;
    setValue((cur) => (cur.trim().length === 0 ? insertText : `${cur}\n${insertText}`));
    inputRef.current?.focus();
  }, [insertNonce, insertText]);
  const replaceNonce = replace?.nonce;
  const replaceText = replace?.text;
  useEffect(() => {
    if (replaceNonce === undefined || replaceText === undefined) return;
    setValue(replaceText);
    inputRef.current?.focus();
  }, [replaceNonce, replaceText]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The dictation preview and chip mirror paint the text over a transparent
  // textarea, so they must scroll with it and wrap at the same width: once the
  // textarea scrolls past its cap it gains a scrollbar (narrower text column),
  // and the mirrors, which never scroll, would clip the text and wrap it
  // differently from the caret.
  function syncMirrors(el: HTMLTextAreaElement): void {
    const wrap = el.parentElement;
    if (!wrap) return;
    const bar = el.offsetWidth - el.clientWidth - 2; // 2 = left+right border
    wrap
      .querySelectorAll<HTMLElement>('.composer-live-preview, .composer-chip-mirror')
      .forEach((m) => {
        m.style.paddingRight = `${14 + Math.max(0, bar)}px`;
        m.scrollTop = el.scrollTop;
      });
  }

  const pushError = useUiStore((s) => s.pushError);
  const dictateChord = useUiStore((s) => s.dictateChord);
  // Attachments the user has added but not yet sent (spec/14 § Composer). They
  // upload on send; a failed upload surfaces an error and keeps the attachment
  // (NO FALLBACK — never silently dropped).
  const attachments = useComposerAttachmentStore((s) => s.byChat[attachmentKey] ?? NO_ATTACHMENTS);
  const setAttachments = (
    fn: PendingAttachment[] | ((cur: PendingAttachment[]) => PendingAttachment[]),
  ): void =>
    useComposerAttachmentStore
      .getState()
      .update(attachmentKey, typeof fn === 'function' ? fn : () => fn);
  // A new-chat send with attachments waiting on the chat to be created
  // (`resolveChatId`). Attachment uploads never hold the composer: the message
  // is in the stream, counting them, the moment Send is pressed.
  const [resolving, setResolving] = useState(false);

  // Skill autocomplete (spec/14 § Composer): typing `/` opens a dropdown of the
  // folder's skills, filtered as you type, ANYWHERE a word starts in the
  // message — the start, or right after whitespace/a newline — not only when
  // the composer holds nothing else. The menu is active only while the token
  // AT THE CURSOR is still open (no closing space yet). Esc dismisses it
  // without clearing the text.
  const activeToken = activeSlashToken(body, cursorPos);
  const slashQuery = activeToken?.query ?? null;
  const slashActive = activeToken !== null;
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [skillIndex, setSkillIndex] = useState(0);
  // Skills are re-read on EVERY open of the menu, not once per folder: the
  // list lives on the host's filesystem and changes there (a skill added,
  // renamed or removed) must show up on the next `/` rather than waiting for a
  // reload. Typing more of the query does not refetch — `slashQuery` is
  // deliberately not a dependency, so one open is one fetch. The last loaded
  // list stays on screen while the new one is in flight, so a reopen never
  // flashes empty. NO FALLBACK: a failed fetch surfaces the error in the
  // dropdown rather than a silently empty list.
  const [skills, setSkills] = useState<string[]>([]);
  // The preview panel's data (spec/14 § Skill autocomplete): `descriptions`
  // feeds each row's second line, `paths`/`frontmatter` feed the highlighted
  // row's preview panel (full description, rest of the frontmatter, Edit
  // link). All three default to `{}` rather than staying undefined so an
  // older host that answers without them reads as "none", not "unknown".
  const [skillDescriptions, setSkillDescriptions] = useState<Record<string, string>>({});
  const [skillPaths, setSkillPaths] = useState<Record<string, string>>({});
  const [skillFrontmatter, setSkillFrontmatter] = useState<Record<string, Record<string, string>>>(
    {},
  );
  const [skillsFolder, setSkillsFolder] = useState<string | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const trimmedFolder = (folder ?? '').trim();
  useEffect(() => {
    if (!slashActive || slashDismissed || trimmedFolder === '' || !hostId) {
      return;
    }
    let live = true;
    void api
      .skills(trimmedFolder, hostId)
      .then((r) => {
        if (!live) return;
        setSkills(r.skills ?? []);
        setSkillDescriptions(r.descriptions ?? {});
        setSkillPaths(r.paths ?? {});
        setSkillFrontmatter(r.frontmatter ?? {});
        setSkillsFolder(trimmedFolder);
        setSkillsError(null);
      })
      .catch((e) => {
        if (live) setSkillsError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [slashActive, slashDismissed, trimmedFolder, hostId]);
  // spec/14 § Composer — chips: a completed `/<skill>` must be recognised (and
  // drawn as a chip, with its preview reachable) even before the `/` menu has
  // ever been opened this session — e.g. reopening a chat whose draft already
  // holds one. So the same list is also primed in the background the first
  // time the text contains a `/` at all, once per folder. Skipped whenever
  // `slashActive` — the interactive fetch above already covers that open, and
  // firing both at once (typing the very first `/` flips BOTH conditions true
  // on the same render) would double-fetch on the commonest path of all,
  // which `Composer.test.tsx`'s call-count assertions catch. Once primed for
  // a folder it stays quiet: it is a background courtesy, not a second
  // freshness guarantee — the interactive fetch's own "re-read on every open"
  // rule (above) is what actually keeps the list current. A failure here is
  // silent for the same reason: this is a courtesy fetch, not the one place a
  // fetch problem is meant to surface.
  const chipFetchPrimedRef = useRef<string | null>(null);
  useEffect(() => {
    if (trimmedFolder === '' || slashActive || !hostId) return;
    if (chipFetchPrimedRef.current === trimmedFolder) return;
    if (!value.includes('/')) return;
    let live = true;
    void api
      .skills(trimmedFolder, hostId)
      .then((r) => {
        if (!live) return;
        // Marked primed only on SUCCESS, and only once the fetch is known to
        // still matter — an attempt React StrictMode's dev-mode double-invoke
        // (mount, cleanup, remount, all synchronously) throws away must not
        // poison the guard, or the surviving second invocation would see it
        // already "primed" and skip fetching for real, leaving a chip that
        // was already in the draft on mount permanently un-rendered.
        chipFetchPrimedRef.current = trimmedFolder;
        setSkills(r.skills ?? []);
        setSkillDescriptions(r.descriptions ?? {});
        setSkillPaths(r.paths ?? {});
        setSkillFrontmatter(r.frontmatter ?? {});
        setSkillsFolder(trimmedFolder);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [trimmedFolder, value, slashActive, hostId]);
  // Built-in slash commands always available regardless of folder.
  const BUILTIN_COMMANDS: { name: string; description: string }[] = [
    { name: CLEAR_COMMAND_NAME, description: CLEAR_COMMAND_DESCRIPTION },
    { name: GOAL_COMMAND_NAME, description: GOAL_COMMAND_DESCRIPTION },
  ];
  // Every name a chip can legitimately be — a skill from the folder, or a
  // built-in — used both to recognise a completed chip anywhere in the text
  // and to know which name a Backspace right after one should remove whole.
  // The provider's own commands win over a same-named skill (the CLI handles
  // them before any skill), so a colliding skill is blocked in the menu and
  // its typed token reads as the provider command, not a skill.
  const providerCommands = useMemo(() => providerBuiltinCommands(accountModel), [accountModel]);
  const providerLabel = providerDescriptor(providerForModel(accountModel)).label;
  const knownChipNames = useMemo(
    () => new Set<string>([...skills, ...providerCommands, ...BUILTIN_COMMANDS.map((c) => c.name)]),
    // BUILTIN_COMMANDS is a fresh array every render but its content is
    // static, so `skills` is the only thing that actually changes this set.
    [skills, providerCommands],
  );
  const chipTokens = useMemo(() => findChipTokens(body, knownChipNames), [body, knownChipNames]);

  // The last skill completed in this folder sorts to the top and is therefore
  // the highlighted default (spec/14 § Skill autocomplete). Ordering only — the
  // prefix filter is applied first, so a last-used skill the query excludes
  // simply isn't there.
  const filteredBuiltins =
    slashQuery !== null ? rankByQuery(BUILTIN_COMMANDS, slashQuery, (c) => c.name) : [];
  const filteredSkills =
    slashQuery !== null
      ? orderSkillsByLastUsed(
          rankByQuery(skills, slashQuery, (s) => s),
          getLastUsedSkill(trimmedFolder),
        )
      : [];
  // Combined list for keyboard navigation: built-ins, then skills — EXCEPT that
  // the last-used skill outranks the built-ins.
  //
  // spec/14 § Skill autocomplete promises that completing a skill sorts it to
  // the top of the next `/` and highlights it, "so `/` + `Enter` re-runs it".
  // Putting built-ins unconditionally first broke that promise the moment
  // `/clear` was added: `/` + `Enter` cleared the transcript instead of
  // re-running the last skill, in every folder that had one.
  //
  // With no last-used skill for this folder there is nothing to outrank, so the
  // list is built-ins first and the feature is unaffected.
  const lastUsed = getLastUsedSkill(trimmedFolder);
  const leadSkill = filteredSkills[0] === lastUsed ? filteredSkills[0] : null;
  const skillItem = (s: string) => ({
    name: s,
    isBuiltin: false,
    description: skillDescriptions[s],
    blocked: providerCommands.has(s),
  });
  const allItems: Array<{
    name: string;
    isBuiltin: boolean;
    description?: string;
    blocked?: boolean;
  }> = [
    ...(leadSkill === null ? [] : [skillItem(leadSkill)]),
    ...filteredBuiltins.map((c) => ({ name: c.name, isBuiltin: true, description: c.description })),
    ...filteredSkills.filter((s) => s !== leadSkill).map(skillItem),
  ];
  // The menu is open whenever `/` is active — an EMPTY result is a state the
  // user is shown, not silence (the user, `patch/todo.md` — "typing / in a folder
  // with no skills shows nothing at all"). Rendering nothing made "this project
  // has no skills" and "the feature is broken" look identical, which is the
  // same no-fallback trap the fetch error already avoids. It stays closed only
  // until the fetch has actually resolved, so `/` never flashes "no skills"
  // at a folder whose list is still in flight. Built-in commands are always
  // available, so the menu opens immediately if any built-in matches.
  const skillsLoaded = skillsFolder === trimmedFolder;
  const showSkillMenu =
    slashActive &&
    !slashDismissed &&
    (skillsLoaded || skillsError !== null || filteredBuiltins.length > 0);
  const activeSkillIndex = Math.min(skillIndex, Math.max(0, allItems.length - 1));
  // spec/14 § Dismissing pop-ups (click-off): a press outside the composer
  // closes the skill menu, exactly as Esc does — the typed `/token` stays put,
  // so the user can carry on where they left off. The whole composer is the
  // region: the menu and the textarea that drives it are one control, so
  // clicking back into the input (or its actions) doesn't dismiss.
  const formRef = useRef<HTMLFormElement>(null);
  useDismissOnClickOff(showSkillMenu, [formRef], () => setSlashDismissed(true));
  // Reset the highlight whenever the typed query changes.
  useEffect(() => {
    setSkillIndex(0);
  }, [slashQuery]);

  function completeItem(name: string, isBuiltin: boolean): void {
    if (!isBuiltin && providerCommands.has(name)) return;
    /* v8 ignore next -- defensive only: completion is only ever reachable
       through a menu row, and the menu only renders while `activeToken` is
       non-null (`showSkillMenu` requires `slashActive`). */
    if (activeToken === null) return;
    // Splices the completed `/<name> ` into place at the active token —
    // wherever in the message that was — leaving anything typed before or
    // after it untouched (spec/14 § Skill autocomplete — mid-message
    // completion). The trailing space commits the token: it stops matching
    // an open `/token`, so the menu closes and it renders as a chip.
    const { text, cursor } = spliceCompletion(body, activeToken.start, cursorPos, name);
    setValue(joinQuotes(quotes, text));
    pendingCursorRef.current = cursor;
    // Only remember last-used for skills (not built-in commands).
    if (!isBuiltin) setLastUsedSkill(trimmedFolder, name);
    setSlashDismissed(true);
    inputRef.current?.focus();
  }
  function addFiles(files: FileList | File[]): void {
    const list = Array.from(files);
    if (list.length === 0) return;
    if (edit) {
      // An edit replaces the text only; the host has no way to add a file to a
      // message already sent. Say so rather than dropping it (spec/12).
      useUiStore.getState().pushError('Files can’t be added while editing a message');
      return;
    }
    setAttachments((cur) => [...cur, ...list.map(makePending)]);
  }

  // Drag-and-drop onto the composer (spec/14 § Composer — attach ANY file,
  // including a dropped folder or a `.zip`, the same way the paperclip does.
  // A depth COUNTER, not a boolean, because dragenter/dragleave fire on every
  // child element the pointer crosses as it moves over the composer — a plain
  // "set true on enter, false on leave" would flicker the overlay off every
  // time the pointer passed over a chip or the input on its way across.
  const [dragDepth, setDragDepth] = useState(0);
  const dropDisabled = linkOrCredentialBlocked || resolving;
  // Shared by the composer's own onDrop and the whole-chat drop zone (spec/14
  // § Composer — the wider zone resolves the DataTransfer itself via the
  // exported `filesFromDataTransfer`, then hands the finished `File[]` here so
  // the SAME "blocked exactly where the paperclip is" guard applies regardless
  // of where in the chat the file landed.
  function attachFiles(files: File[]): void {
    if (dropDisabled) return;
    addFiles(files);
  }
  useImperativeHandle(ref, () => ({ attachFiles, isDropBlocked: () => dropDisabled }), [
    dropDisabled,
  ]);
  function onDragEnter(e: React.DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    // Stopped here, not just prevented — the whole-chat drop zone (a listener
    // further up the tree, spec/14 § Composer) tracks its own depth counter
    // from the SAME dragenter/dragleave pairs. Left to bubble, moving onto the
    // composer would count as "entering" for both zones and show two overlays
    // stacked on each other.
    e.stopPropagation();
    setDragDepth((d) => d + 1);
  }
  function onDragOver(e: React.DragEvent): void {
    if (!dragHasFiles(e)) return;
    // Required on every dragover, not just dragenter — a browser treats an
    // element as not-a-drop-target unless THIS handler also prevents default.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = dropDisabled ? 'none' : 'copy';
  }
  function onDragLeave(e: React.DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragDepth((d) => Math.max(0, d - 1));
  }
  function onDrop(e: React.DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragDepth(0);
    const dt = e.dataTransfer;
    void filesFromDataTransfer(dt).then((files) => attachFiles(files));
  }

  function removeAttachment(key: string): void {
    setAttachments((cur) => {
      const found = cur.find((a) => a.key === key);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      return cur.filter((a) => a.key !== key);
    });
  }

  // The pending image currently open in the markup editor (spec/14 § Composer
  // — screenshot markup). Swapping its `file`/`previewUrl` in place keeps the
  // same `key`, so it stays the same chip and flows through the ordinary
  // upload path unchanged.
  const [annotating, setAnnotating] = useState<PendingAttachment | null>(null);
  const [sketching, setSketching] = useState(false);
  // The pending image open in the full-screen preview (click its thumbnail).
  const [previewing, setPreviewing] = useState<PendingAttachment | null>(null);

  function replaceAttachmentFile(key: string, file: File): void {
    setAttachments((cur) =>
      cur.map((a) => {
        if (a.key !== key) return a;
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        return { ...a, file, name: file.name, previewUrl: URL.createObjectURL(file) };
      }),
    );
  }

  // spec/14 § Composer — pasting a clipboard image (screenshot / copied image)
  // attaches it directly (⌘V / Ctrl V into the composer).
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const items = e.clipboardData?.items;
    if (!items) return;
    // spec/14 § Composer — a long text paste becomes a document attachment.
    const text = e.clipboardData.getData?.('text/plain') ?? '';
    if (!edit && text.length >= LONG_PASTE_CHARS) {
      e.preventDefault();
      addFiles([new File([text], pastedTextName(text), { type: 'text/markdown' })]);
      return;
    }
    const imgs: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length > 0) {
      e.preventDefault();
      addFiles(imgs);
    }
  }
  // Mic gesture state. spec/07 ## Voice-input modes: the same mic control
  // supports BOTH gestures — press-and-hold (release commits) and a single tap
  // that flips into a Superwhisper-style toggle session (a second tap commits).
  //
  // Two modes (see the `onStartVoiceNote` prop doc):
  //   • NOTE mode      — `onStartVoiceNote` provided → drives the voice-NOTE
  //     overlay (fire-a-turn). Used by the "voice starts a chat" flow.
  //   • TRANSCRIBE mode — default → records locally and drops the recognised
  //     text into the composer input, editable before send (spec/C1). NO overlay.
  const noteMode = onStartVoiceNote !== undefined;
  const noteActive = useVoiceStore((s) => s.note !== null);
  const onCall = useVoiceStore((s) => s.call !== null && s.call.chatId === chatId);
  const inMeeting = useMeetingStore((s) => isMeetingOpen(s.byChat[chatId]));
  // Once ever: introduce what a meeting needs on this Mac, on the Meeting button.
  // The Manager coordinates other chats; it takes no meeting notes.
  const hasMeetingButton =
    !edit &&
    chatId !== SPECIAL_THREAD_IDS.manager &&
    (chatId !== 'new' || onStartMeeting !== undefined);
  useEffect(() => {
    if (!hasMeetingButton) return;
    maybeIntroduceMeetings(chatId).catch((err: unknown) =>
      useUiStore
        .getState()
        .pushError(`Could not check meeting permissions: ${(err as Error).message}`),
    );
  }, [chatId, hasMeetingButton]);
  // A note that failed or was cancelled hands back the text it lifted out of a
  // composer when it started (voiceStore § composerRestore). Take it back into
  // the input so the user can retry or send it by hand — NO FALLBACK: a note
  // that never delivered must not cost him the words he had already typed.
  //
  // The composer that gets the text back is usually NOT the one that owed it:
  // the new-chat composer unmounts on the navigation into the chat it created,
  // so this lands in that chat's composer instead, which is where the user is
  // now looking. An entry left for a chat that is not on screen is applied when
  // its composer next mounts.
  const composerRestore = useVoiceStore((s) => s.composerRestore);
  useEffect(() => {
    if (composerRestore === null || composerRestore.chatId !== chatId) return;
    const owed = composerRestore.text;
    useVoiceStore.getState().clearComposerRestore();
    // The owed text was typed FIRST, so it leads anything typed since the note
    // started, joined the same way the turn itself would have been joined.
    setValue((cur) => {
      const { quotes: q, body: b } = splitQuotes(cur);
      return joinQuotes(q, b.trim().length > 0 ? `${owed.trimEnd()} ${b.trimStart()}` : owed);
    });
  }, [composerRestore, chatId]);
  const pressAt = useRef<number | null>(null);
  const toggledOpen = useRef(false);
  // Transcribe-mode recording state.
  const [micState, setMicState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  // The host's interim transcript of what has been said so far (spec/07 §
  // Dictation into the composer). Shown GREYED, mirrored behind the input, and
  // dropped the instant the authoritative transcript lands — it is a preview of
  // a guess, never something the user is left holding and unable to edit.
  const [livePartial, setLivePartial] = useState('');
  const recordingRef = useRef<VoiceRecording | null>(null);
  const previewRef = useRef<DictationPreview | null>(null);
  // The mic marker (and any words heard so far) stays drawn through
  // 'transcribing' until the authoritative transcript replaces it, rather than
  // vanishing mid-wait. It replaces the old status line above the input.
  const showLivePreview = micState !== 'idle';

  // Auto-grow the textarea to fit its content. `field-sizing: content` (CSS) is
  // unreliable in the desktop shell, so size it here: reset to `auto` (allows
  // shrinking), then to scrollHeight (clamped at the cap). Crucially, keep
  // overflow HIDDEN while the content fits under the cap — the field simply
  // expands/contracts, no scrollbar (spec/14 § Composer). Only once the content
  // genuinely exceeds the cap do we reveal an internal scrollbar so a long paste
  // can't push the chat off-screen.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // `scrollHeight` is the content+padding box; with `box-sizing: border-box`
    // the style height also includes the border, so add the border delta —
    // otherwise the box lands 1–2px short of the content and clips it (which is
    // exactly what makes a spurious scrollbar flicker in). offsetHeight -
    // clientHeight is that border total (overflow is hidden here, so no
    // scrollbar contributes to it).
    const border = el.offsetHeight - el.clientHeight;
    // While dictating, the interim transcript is painted by the mirror, not
    // held by the textarea, so its text never reaches `el.scrollHeight`: size
    // to whichever is taller. The mirror is absolutely filling the wrapper
    // (now at the textarea's `auto` height), so its scrollHeight is its content.
    const mirror = el.parentElement?.querySelector<HTMLElement>(
      '.composer-live-preview, .composer-chip-mirror',
    );
    const contentHeight = Math.max(el.scrollHeight, mirror?.scrollHeight ?? 0) + border;
    const cap = maxInputHeight();
    el.style.height = `${Math.min(contentHeight, cap)}px`;
    el.style.overflowY = contentHeight > cap ? 'auto' : 'hidden';
    syncMirrors(el);
  }, [value, livePartial, showLivePreview]);
  // spec/14 § Composer — chips: the mirror only needs to exist while there is
  // at least one chip to draw, and only when dictation isn't already using
  // the transparent-textarea trick for its own mirror (the two never overlap
  // — a chip typed while dictating simply isn't boxed until the dictation
  // preview ends, since both would otherwise fight over the same technique).
  const showChipMirror = !showLivePreview && chipTokens.length > 0;
  // Layout effect: the mirror mounts and the textarea resizes in the same
  // commit, and the mirror must be sized before the browser paints.
  useLayoutEffect(() => {
    if (inputRef.current) syncMirrors(inputRef.current);
  }, [value, showLivePreview, showChipMirror]);
  const [chipPreview, setChipPreview] = useState<ChipPreviewState | null>(null);
  const chipPreviewRef = useRef<HTMLDivElement>(null);
  const [chipPreviewPos, setChipPreviewPos] = useState<TooltipPosition | null>(null);
  useDismissOnClickOff(chipPreview !== null, [chipPreviewRef], () => setChipPreview(null));
  // Two-phase, like TooltipHost: paint invisibly first so the popover can be
  // measured, then place it — avoids guessing its size to keep it clear of
  // the window edge.
  useLayoutEffect(() => {
    if (!chipPreview) {
      setChipPreviewPos(null);
      return;
    }
    const el = chipPreviewRef.current;
    if (!el) return;
    setChipPreviewPos(
      computeTooltipPosition(chipPreview.rect, el.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [chipPreview]);

  // Leaving the chip does not close the popover at once: the pointer has to be
  // able to cross the gap to it (its Edit link is only reachable that way).
  // Entering the popover cancels the close; leaving the popover restarts it.
  const chipPreviewCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelChipPreviewClose(): void {
    if (chipPreviewCloseTimer.current) clearTimeout(chipPreviewCloseTimer.current);
    chipPreviewCloseTimer.current = null;
  }
  function scheduleChipPreviewClose(name?: string): void {
    cancelChipPreviewClose();
    chipPreviewCloseTimer.current = setTimeout(() => {
      chipPreviewCloseTimer.current = null;
      setChipPreview((cur) => (name === undefined || cur?.name === name ? null : cur));
    }, 250);
  }
  useEffect(() => cancelChipPreviewClose, []);

  function showChipPreview(name: string, target: HTMLElement): void {
    cancelChipPreviewClose();
    setChipPreview({
      name,
      isBuiltin: BUILTIN_COMMANDS.some((c) => c.name === name),
      rect: target.getBoundingClientRect(),
    });
  }

  /** The visible text, with every completed `/<skill>` swapped for a boxed,
   *  hoverable/tappable chip (spec/14 § Skill autocomplete — same preview as
   *  the list: description, frontmatter, Edit link). */
  function renderChipMirror(): JSX.Element[] {
    const nodes: JSX.Element[] = [];
    let cursor = 0;
    chipTokens.forEach((chip, i) => {
      if (chip.start > cursor) {
        nodes.push(<span key={`text-${i}`}>{body.slice(cursor, chip.start)}</span>);
      }
      nodes.push(
        <span
          key={`chip-${i}`}
          className={`composer-chip${providerCommands.has(chip.name) && !BUILTIN_COMMANDS.some((c) => c.name === chip.name) ? ' command' : ''}`}
          data-testid="composer-chip"
          data-skill={chip.name}
          onMouseEnter={(e) => showChipPreview(chip.name, e.currentTarget)}
          onMouseLeave={() => scheduleChipPreviewClose(chip.name)}
          onClick={(e) => {
            e.preventDefault();
            const target = e.currentTarget;
            setChipPreview((cur) => {
              if (cur?.name === chip.name) return null;
              return {
                name: chip.name,
                isBuiltin: BUILTIN_COMMANDS.some((c) => c.name === chip.name),
                rect: target.getBoundingClientRect(),
              };
            });
          }}
        >
          /{chip.name}
        </span>,
      );
      cursor = chip.end;
    });
    if (cursor < body.length) nodes.push(<span key="text-tail">{body.slice(cursor)}</span>);
    return nodes;
  }
  // While voice is running, the input is being painted over: the live-dictation
  // mirror sits exactly on top of the textarea, and a note's overlay owns the
  // input's ⏎/esc. The placeholder is painted by the textarea itself, in the
  // same box, so on an EMPTY input it renders THROUGH the preview and the two
  // strings sit on top of each other (Todoist 6hVPGMcWfgcW6256: "when voice
  // note is recording, placeholder should disappear, its writing on top").
  // Nothing about an empty input needs naming while the user is talking into it.
  const suppressPlaceholder = showLivePreview || noteActive || micState !== 'idle';
  // Stop and Send never show together: an empty composer on a running turn
  // offers Stop; anything to send (text, attachments, dictation) offers Send.
  const hasContent = value.trim().length > 0 || attachments.length > 0 || micState !== 'idle';
  // A send the host has not yet confirmed as `running` also offers Stop: the
  // gap between pressing Send and the first `chat.state` is otherwise a
  // composer with neither button. Bounded so a send that never gets a
  // `running` back (offline, failed) settles instead of holding Stop forever.
  const [pendingSend, setPendingSend] = useState(false);
  useEffect(() => {
    if (running) setPendingSend(false);
  }, [running]);
  useEffect(() => {
    if (!pendingSend) return;
    const t = setTimeout(() => setPendingSend(false), 10_000);
    return () => clearTimeout(t);
  }, [pendingSend]);
  // A hook check in flight shows its own Checking… button, not Stop.
  const showStop = !edit && (running || (pendingSend && !checking)) && !!onStop && !hasContent;
  const recPrepareRef = useRef<Promise<void> | null>(null);
  // Send pressed while dictating: the dictation ends and, once its transcript
  // lands, the whole message (typed text + transcript) goes out as one turn.
  const sendAfterDictationRef = useRef(false);
  // Bumped whenever a recording starts/stops/cancels; a late async prepare
  // checks it and bails (or self-cancels) instead of clobbering a newer gesture.
  const recGenRef = useRef(0);
  // A dictation session is ended by a GESTURE, never by silence (spec/07 § 4):
  // a pause mid-sentence is normal dictation, so a hands-free toggle session
  // stays open until the mic is tapped again (commit) or esc (cancel).

  // The latch is a DICTATION-only concept. A voice note's open/closed state
  // lives in the store, which every surface can see, so the mic reads that
  // directly (see `onMicDown`) instead of a local flag that desyncs the moment a
  // note is ended by a path the composer never sees — the global ⏎/Esc handlers
  // in AppShell, an onError abort, or the sidebar row's press-and-hold. A stale
  // latch used to swallow the NEXT tap ("commit the open toggle session"), so
  // the overlay never reopened and the mic appeared dead.

  // --- NOTE mode ---
  function beginNote(gesture: 'ptt' | 'toggle'): void {
    onStartVoiceNote?.(chatId, gesture, value);
  }

  // --- TRANSCRIBE mode (C1) ---
  /** Close the live-preview leg, if one is open, and drop its text. */
  function endPreview(): void {
    stopPreview();
    setLivePartial('');
  }
  /** Close the live-preview leg but leave its last words showing. */
  function stopPreview(): void {
    previewRef.current?.stop();
    previewRef.current = null;
  }

  /**
   * Tee the recording already in progress into a host audio session so the
   * interim transcript paints while the user is still speaking. Strictly
   * additive: the clip this recorder returns, and the transcript uploaded from
   * it, are what the composer actually uses.
   *
   * Anything that goes wrong here is reported and then dropped, because the
   * recording it is decorating is already live and correct — killing a good
   * dictation over a failed preview would lose words the user has spoken. It is
   * NOT swallowed: `pushError` puts it in front of the user, so a live leg that
   * has stopped working can't be mistaken for a quiet one.
   */
  function startLivePreview(rec: VoiceRecording, gen: number): void {
    try {
      const openPreview = previewFactory ?? startDictationPreview;
      previewRef.current = openPreview(chatId, {
        onPartial: (text: string) => {
          if (gen !== recGenRef.current) return;
          setLivePartial(text);
        },
        onPreviewError: (message: string) => {
          pushError(`voice: live transcript unavailable (still recording): ${message}`);
        },
      });
      rec.onPcm((pcm) => previewRef.current?.push(pcm));
    } catch (e) {
      previewRef.current = null;
      pushError(`voice: live transcript unavailable (still recording): ${(e as Error).message}`);
    }
  }

  async function beginRecording(): Promise<void> {
    const gen = ++recGenRef.current;
    setMicState('recording');
    setLivePartial('');
    const factory = recorderFactory ?? startRecording;
    recPrepareRef.current = (async () => {
      try {
        const rec = await factory();
        if (gen !== recGenRef.current) {
          // Committed/cancelled while the mic was spinning up.
          rec.cancel();
          return;
        }
        recordingRef.current = rec;
        startLivePreview(rec, gen);
      } catch (e) {
        if (gen !== recGenRef.current) return;
        recordingRef.current = null;
        endPreview();
        setMicState('idle');
        pushError(`voice: could not start recording: ${(e as Error).message}`);
      }
    })();
    await recPrepareRef.current;
  }

  async function commitRecording(): Promise<void> {
    // Wait for a still-in-flight start so a quick hold/release still has audio.
    const prep = recPrepareRef.current;
    if (prep) await prep.catch(() => undefined);
    const rec = recordingRef.current;
    recordingRef.current = null;
    recGenRef.current++; // invalidate any still-in-flight prepare
    // The preview's job is over the moment the gesture ends: from here the
    // authoritative transcript is the only text that may reach the input. The
    // last interim words stay drawn until it lands (cleared in `finally`).
    stopPreview();
    if (!rec) {
      setLivePartial('');
      setMicState('idle');
      pushError('voice: nothing recorded (released too quickly?). Hold a beat longer.');
      return;
    }
    setMicState('transcribing');
    try {
      const clip = await rec.stop();
      const doTranscribe = transcribeClip ?? ((c: Blob) => api.voiceTranscribe(c));
      const { transcript } = await doTranscribe(clip);
      const t = transcript.trim();
      const cur = valueRef.current;
      const next = t && cur.trim().length > 0 ? `${cur.trimEnd()} ${t}` : t || cur;
      const send = sendAfterDictationRef.current;
      sendAfterDictationRef.current = false;
      if (send) {
        // Not sendable (nothing heard, or sending blocked): the words stay in
        // the box rather than vanish, and the user is told.
        if (!submitRef.current(next)) {
          setValue(next);
          pushError(t ? 'voice: message not sent' : 'voice: nothing heard, nothing sent');
        }
      } else {
        // Mic tapped again: append into the composer, editable before send.
        if (t) setValue(next);
        inputRef.current?.focus();
      }
    } catch (e) {
      sendAfterDictationRef.current = false;
      pushError(failed('voice transcription'), undefined, (e as Error).message);
    } finally {
      setLivePartial('');
      setMicState('idle');
    }
  }

  function cancelRecording(): void {
    sendAfterDictationRef.current = false;
    // Otherwise the next press "ends" the cancelled session instead of
    // starting a new one, and the mic looks dead.
    toggledOpen.current = false;
    recGenRef.current++;
    recordingRef.current?.cancel();
    recordingRef.current = null;
    endPreview();
    setMicState('idle');
  }

  // Dictation mode (spec/07 § Dictation mode): right-click the mic → Keep
  // dictating, and it stays open — each time the speaker finishes what they
  // said is sent as its own message, and it keeps listening. Clicking the mic
  // or Esc ends it. Not a call: nothing speaks back.
  const [dictModeOn, setDictModeOn] = useState(false);
  const [dictPending, setDictPending] = useState(0);
  const dictModeRef = useRef<DictationMode | null>(null);
  function stopDictationMode(): void {
    const mode = dictModeRef.current;
    dictModeRef.current = null;
    mode?.stop();
    setDictModeOn(false);
    setDictPending(0);
  }
  function startDictMode(): void {
    if (voiceDisabled || noteMode || noteActive || micState !== 'idle') return;
    if (dictModeRef.current) {
      stopDictationMode();
      return;
    }
    const factory = dictationModeFactory ?? startDictationMode;
    const prefs = usePreferencesStore.getState().preferences;
    const mode = factory(
      {
        transcribe: (c: Blob) => api.voiceTranscribe(c),
        ...(prefs.dictationTurnDetection ? { turnCheck: (c: Blob) => api.voiceTurnCheck(c) } : {}),
        segmenter: { silenceMs: prefs.dictationPauseSeconds * 1000 },
      },
      {
        onText: (t: string) => {
          const cur = valueRef.current;
          const text = cur.trim().length > 0 ? `${cur.trimEnd()} ${t}` : t;
          if (!submitRef.current(text)) {
            setValue(text);
            pushError('voice: message not sent');
          }
        },
        onBusy: (n: number) => setDictPending(n),
        onError: (message: string) => pushError(message),
      },
    );
    dictModeRef.current = mode;
    setDictModeOn(true);
    mode.ready.catch((e: Error) => {
      if (dictModeRef.current !== mode) return;
      dictModeRef.current = null;
      setDictModeOn(false);
      pushError(`voice: could not start recording: ${e.message}`);
    });
  }
  // Leaving the chat (or unmounting) must release the microphone.
  useEffect(() => stopDictationMode, [chatId]);

  function onMicDown(at: number): void {
    if (dictModeRef.current) {
      stopDictationMode();
      return;
    }
    /* v8 ignore next -- defensive only: the mic button carries `disabled={voiceDisabled}`, and React suppresses onMouseDown dispatch entirely on a disabled form control (verified: fireEvent.mouseDown on a disabled button never invokes the handler), so `onMicDown` can never actually run while `voiceDisabled` is true. */
    if (voiceDisabled) return;
    // A note already in flight (sidebar row, ⌘⇧D/⌃Space hotkey, or the new-chat
    // mic whose note survives the navigation into the chat it created) is ENDED
    // by this press — never shadowed by a second, overlapping recording
    // (spec/07). This holds in dictation mode too: the mic the user reaches for
    // next is whichever one is on screen, and it must mean "stop that note".
    if (noteActive) {
      toggledOpen.current = false;
      sendVoiceNote();
      return;
    }
    // A press while a dictation toggle session is open ends/commits it. (Voice
    // NOTES never reach here — the store branch above owns them.)
    if (toggledOpen.current) {
      toggledOpen.current = false;
      void commitRecording();
      return;
    }
    pressAt.current = at;
    if (noteMode) beginNote('ptt');
    else void beginRecording();
  }
  function onMicUp(at: number): void {
    if (pressAt.current === null) return;
    const held = at - pressAt.current;
    pressAt.current = null;
    // A NOTE's gesture lives in the STORE, and the release rule is the same one
    // the ⌘⇧D / ⌃Space hotkeys use — a quick tap opens a sustained session (⏎
    // sends), a genuine press-and-hold commits. It is shared rather than
    // reimplemented here so the mic button and the hotkey can't drift apart.
    if (noteMode) {
      releaseVoiceNoteHold(held);
      return;
    }
    if (held < TAP_THRESHOLD_MS) {
      // Quick tap → keep dictating; a second tap commits. Dictation has no
      // store-side session, so the latch is local.
      toggledOpen.current = true;
      return;
    }
    void commitRecording();
  }

  // Call (spec/14 § Composer) — starts a sustained voice call for this chat.
  // On a not-yet-spawned chat (`resolveChatId` provided), the chat is created
  // first, same create-then-act shape as an attachment upload above; a chat
  // that already exists just calls straight through.
  async function handleCall(): Promise<void> {
    // spec/07 § 2. Voice call — the control shows the call is on, and ends it.
    if (onCall) {
      endVoiceCall();
      return;
    }
    if (onStartCall) {
      onStartCall();
      return;
    }
    if (resolveChatId) {
      const target = await resolveChatId();
      if (target !== null) void startVoiceCall(target);
      return;
    }
    void startVoiceCall(chatId);
  }

  // ⌘⇧D drives this mic (lib/composerMic.ts) in transcribe mode. Read through a
  // ref so the hotkey always reaches this render's handlers.
  const micHandlersRef = useRef({ down: onMicDown, up: onMicUp });
  micHandlersRef.current = { down: onMicDown, up: onMicUp };
  useEffect(() => {
    if (noteMode || edit) return;
    return registerComposerMic(chatId, {
      down: (at) => micHandlersRef.current.down(at),
      up: (at) => micHandlersRef.current.up(at),
    });
  }, [chatId, noteMode, !!edit]);

  // Unmount (switching chats, closing the window) must not leave the preview's
  // audio session open on the host — the recording is already gone with the
  // component, and a session with nothing feeding it just holds a slot.
  useEffect(() => {
    return () => {
      previewRef.current?.stop();
      previewRef.current = null;
    };
  }, []);

  // Deterministic auto-focus (spec/14 § Composer — opening a chat puts the
  // cursor in the composer; § New chat). The bare `autoFocus` attribute is
  // unreliable when the composer mounts before the WS hydrates the chat roster
  // — focus via effect once, on mount.
  // An editor was opened by a click, for the purpose of typing: it takes the
  // cursor unconditionally, caret at the end of the text.
  useEffect(() => {
    if (!edit) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const autoFocusedRef = useRef(false);
  useEffect(() => {
    // Focus on the autoFocus→ready transition (not on every keystroke — value
    // is intentionally not a dependency).
    if (!autoFocus || offline) return;
    // Touch devices: focusing raises the soft keyboard over the transcript.
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
      return;
    // At most once per mount. `offline` has to stay a dependency (the composer
    // routinely mounts before the socket connects), but a LATER reconnect must
    // not yank the cursor back out of wherever the user has since moved it.
    if (autoFocusedRef.current) return;
    if (focusIsClaimed()) return;
    inputRef.current?.focus();
    autoFocusedRef.current = true;
  }, [autoFocus, offline]);

  // Focus the input after the agent responds (todo — "Focus the input after
  // responding."). When a turn finishes, `running` flips true → false; return
  // focus to the composer so the user can type the next message straight away.
  // Only fires on the running→idle transition (tracked via a ref) so it never
  // steals focus on mount or when a turn STARTS, and stays quiet while offline
  // (the input is disabled then).
  const wasRunningRef = useRef(running);
  useEffect(() => {
    if (wasRunningRef.current && !running && !offline) {
      inputRef.current?.focus();
    }
    wasRunningRef.current = running;
  }, [running, offline]);

  const sendMenu = useContextMenu();
  // Right-click the mic: the ways to dictate beyond a plain click.
  const micMenu = useContextMenu();
  const micMenuItems: ContextMenuItem[] = [
    {
      id: 'keep-dictating',
      label: 'Keep dictating',
      icon: <Mic size={14} aria-hidden />,
      run: () => startDictMode(),
    },
  ];
  const [scheduling, setScheduling] = useState<{ at: string; error: string | null } | null>(null);

  /** Local `YYYY-MM-DDTHH:mm` for a datetime-local input, defaulting to an hour out. */
  function defaultScheduleAt(): string {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  const sendMenuItems: ContextMenuItem[] = [
    ...(onScheduleSend && attachments.length === 0
      ? [
          {
            id: 'scheduled-send',
            label: 'Scheduled send',
            icon: <Clock size={ICON_SIZE} aria-hidden />,
            run: () => setScheduling({ at: defaultScheduleAt(), error: null }),
          },
        ]
      : []),
    {
      id: 'send-interrupt',
      label: 'Send, interrupt immediately',
      icon: <Zap size={ICON_SIZE} aria-hidden />,
      // Send, then promote it (spec/04 § Message queueing § Promote): the
      // running turn is cut short and this message goes in now.
      run: () => {
        submitRef.current(value, false, true);
      },
    },
    {
      id: 'send-after-finished',
      label: 'Send, wait until agent finished',
      icon: <Send size={ICON_SIZE} aria-hidden />,
      // A send while a turn runs queues behind it and never interrupts it
      // (spec/04 § Message queueing) — this is that path, named explicitly.
      run: () => {
        submitRef.current(value, true);
      },
    },
    ...(onAddToTodo && chatId !== 'new' && micState === 'idle'
      ? [
          {
            id: 'add-to-todo',
            label: 'Add to todo list',
            icon: <ListPlus size={ICON_SIZE} aria-hidden />,
            run: () => {
              const text = value.trim();
              const files = attachments;
              if (!text && files.length === 0) return;
              void onAddToTodo(text, files).then((ok) => {
                if (ok === false) return;
                setValue('');
                setAttachments([]);
              });
            },
          },
        ]
      : []),
  ];

  async function confirmSchedule(): Promise<void> {
    if (!scheduling || !onScheduleSend) return;
    const when = new Date(scheduling.at);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      setScheduling({ ...scheduling, error: 'Pick a time in the future' });
      return;
    }
    const text = value.trim();
    if (!text) return;
    try {
      await onScheduleSend(text, when.toISOString());
      setValue('');
      setScheduling(null);
    } catch (err) {
      setScheduling({ ...scheduling, error: (err as Error).message });
    }
  }

  function handleSubmit(interrupt = false): void {
    // Send while dictating ends the dictation and sends what it heard along
    // with anything typed. Mid-transcription (mic already tapped off) the
    // send just waits for the transcript.
    if (micState !== 'idle') {
      sendAfterDictationRef.current = true;
      if (micState === 'recording') {
        toggledOpen.current = false;
        pressAt.current = null;
        void commitRecording();
      }
      return;
    }
    submitText(value, false, interrupt);
  }

  /** Returns false when there was nothing to send or sending is blocked. */
  function submitText(text: string, afterTurn = false, interrupt = false): boolean {
    if (resolving) return false;
    if (edit) {
      const edited = text.trim();
      if (!edited && !edit.allowEmpty) return false;
      edit.onSave(edited);
      return true;
    }
    // The textarea itself stays enabled while offline (typing is never
    // blocked), so Enter's direct call here — not gated by the send
    // button's own `disabled` — needs its own guard. `sendBlocked` only
    // trips for a not-yet-spawned new chat or a missing credential; an
    // existing chat sent to while offline proceeds and queues.
    if (sendBlocked) return false;
    const trimmed = text.trim();
    // A turn is sendable when there's text OR at least one attachment.
    if (!trimmed && attachments.length === 0) return false;

    // spec/15 § Composer → Attachments — a send with attachments reacts at
    // once, exactly as a text send does: the composer clears and the caller
    // echoes the message, uploading its files in the stream. The files change
    // hands (their preview URLs are drawn in the stream now), so they are not
    // revoked here.
    const pending = attachments;
    if (pending.length > 0 && resolveChatId) {
      // A brand-new chat (chatId === "new") has nowhere to upload to yet:
      // `resolveChatId` creates it first (spec/14 § New chat). Creation
      // failing keeps the text + attachments (error already surfaced). The
      // text is put in the box first: a dictated send has it nowhere else.
      setValue(text);
      setResolving(true);
      void (async () => {
        try {
          const target = await resolveChatId();
          if (!target) return;
          setAttachments([]);
          setValue('');
          finishSend(trimmed, pending, target, afterTurn, interrupt);
        } finally {
          setResolving(false);
        }
      })();
      return true;
    }

    // Clear optimistically, restore on a reported failure.
    setAttachments([]);
    setValue('');
    finishSend(trimmed, pending, pending.length > 0 ? chatId : undefined, afterTurn, interrupt);
    return true;
  }

  // The dictation commit submits after an await, so it calls the latest
  // render's submit (current attachments, blocked state) rather than its own.
  const submitRef = useRef(submitText);
  submitRef.current = submitText;

  /** Fire onSend and restore the typed text (and files) if the send reports failure. */
  function finishSend(
    trimmed: string,
    files: PendingAttachment[],
    resolvedChatId: string | undefined,
    afterTurn: boolean,
    interrupt = false,
  ): void {
    // Call with the bare message for a text-only turn (keeps the call shape
    // stable for callers/tests that predate attachments); pass the files + the
    // chatId only when there are attachments to carry.
    const hasFiles = files.length > 0;
    const args: Parameters<ComposerProps['onSend']> = interrupt
      ? [trimmed, hasFiles ? files : undefined, resolvedChatId, { interrupt: true }]
      : afterTurn
        ? [trimmed, hasFiles ? files : undefined, resolvedChatId, { afterTurn: true }]
        : hasFiles
          ? [trimmed, files, resolvedChatId]
          : [trimmed];
    if (!running && onStop) setPendingSend(true);
    const restore = (): void => {
      setPendingSend(false);
      setValue((cur) => (cur.length === 0 ? trimmed : cur));
      if (hasFiles) setAttachments((cur) => [...files, ...cur]);
    };
    const result = onSend(...args);
    if (result instanceof Promise) {
      void result.then((ok) => {
        if (ok === false) restore();
      });
    } else if (result === false) {
      restore();
    }
  }

  return (
    <form
      ref={formRef}
      className={`composer${dragDepth > 0 ? ' composer-drag-active' : ''}${edit ? ' composer-editing' : ''}${editingTurn ? ' composer-editing-turn' : ''}`}
      data-testid={edit ? 'msg-editor' : 'composer'}
      data-chat-id={chatId}
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {editingTurn ? (
        <div className="composer-edit-banner" data-testid="composer-edit-banner">
          <span>Editing from this message</span>
          <button
            type="button"
            className="msg-edit-cancel"
            data-testid="composer-edit-cancel"
            onClick={editingTurn.onCancel}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {dragDepth > 0 ? (
        <div className="composer-drop-hint" data-testid="composer-drop-hint" aria-hidden>
          {dropDisabled ? 'Can’t attach right now' : 'Drop to attach'}
        </div>
      ) : null}
      {/* Slash-command dropdown (spec/14 § Composer). Shows the folder's
          last-used skill (if any), then built-in commands (e.g. /clear), then
          the remaining folder skills. ↑/↓ move, Enter/Tab completes, Esc
          dismisses, click completes. The highlighted row's preview panel sits
          beside the list (spec/14 § Skill autocomplete). */}
      {showSkillMenu ? (
        <div className="composer-skill-popover">
          <div className="composer-skill-menu" data-testid="composer-skill-menu" role="listbox">
            {skillsError && allItems.length === 0 ? (
              <p className="composer-skill-error" data-testid="composer-skill-error">
                {skillsError}
              </p>
            ) : allItems.length === 0 ? (
              <p className="composer-skill-empty" data-testid="composer-skill-empty">
                {skills.length === 0 ? 'No skills in this project' : 'No matching skill'}
              </p>
            ) : (
              allItems.map((item, i) => (
                <button
                  key={`${item.isBuiltin ? 'builtin' : 'skill'}-${item.name}`}
                  type="button"
                  role="option"
                  aria-selected={i === activeSkillIndex}
                  className={`composer-skill-option${i === activeSkillIndex ? ' active' : ''}${item.isBuiltin ? ' builtin' : ''}${item.blocked ? ' blocked' : ''}`}
                  aria-disabled={item.blocked || undefined}
                  title={
                    item.blocked
                      ? `/${item.name} is a built-in ${providerLabel} command, so this skill can't be used here`
                      : undefined
                  }
                  data-testid={`composer-skill-option-${item.name}`}
                  // Hover moves the selection (mousemove, not mouseenter, so a
                  // keyboard-driven scroll under a still pointer doesn't steal
                  // it): one highlighted row, not a hover row plus a keyboard row.
                  onMouseMove={() => setSkillIndex(i)}
                  // Use mousedown so completion runs before the textarea blurs.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    completeItem(item.name, item.isBuiltin);
                  }}
                >
                  <span className="composer-skill-option-row">
                    <span className="composer-skill-slash" aria-hidden>
                      /
                    </span>
                    {item.name}
                  </span>
                  {item.description ? (
                    <span className="composer-skill-desc">{item.description}</span>
                  ) : null}
                </button>
              ))
            )}
            {skillsError && allItems.length > 0 ? (
              <p className="composer-skill-error" data-testid="composer-skill-error">
                {skillsError}
              </p>
            ) : null}
          </div>
          {allItems.length > 0 ? (
            <SkillPreviewPanel
              item={allItems[activeSkillIndex]}
              paths={skillPaths}
              frontmatter={skillFrontmatter}
              hostId={hostId ?? ''}
              folder={trimmedFolder}
            />
          ) : null}
        </div>
      ) : null}
      {/* Quote cards stacked above the input (spec/14 § Composer — quotes). */}
      {quotes.length > 0 ? (
        <div className="composer-quotes" data-testid="composer-quotes">
          {quotes.map((q, i) => (
            <div key={i} className="composer-quote" data-testid="composer-quote">
              <span className="composer-quote-text">{q}</span>
              <button
                type="button"
                className="composer-quote-remove"
                data-testid="composer-quote-remove"
                aria-label="remove quote"
                title="Remove quote"
                onClick={() =>
                  setValue(
                    joinQuotes(
                      quotes.filter((_, j) => j !== i),
                      body,
                    ),
                  )
                }
              >
                <CloseIcon size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {/* Removable thumbnails/chips above the input (spec/14 § Composer). */}
      {attachments.length > 0 ? (
        <div className="composer-attachments" data-testid="composer-attachments">
          {attachments.map((a) => (
            <div
              key={a.key}
              className={`composer-attachment${resolving ? ' uploading' : ''}`}
              data-testid="composer-attachment"
            >
              {a.kind === 'image' && a.previewUrl ? (
                <button
                  type="button"
                  className="att-preview"
                  data-testid="composer-attachment-preview"
                  aria-label={`preview ${a.name}`}
                  title="Preview image"
                  onClick={() => setPreviewing(a)}
                >
                  <img src={a.previewUrl} alt={a.name} />
                </button>
              ) : (
                <FileText size={18} aria-hidden />
              )}
              <span className="att-name">{a.name}</span>
              {a.kind === 'image' ? (
                <button
                  type="button"
                  className="att-markup"
                  data-testid="composer-attachment-markup"
                  aria-label={`markup ${a.name}`}
                  title="Markup image"
                  onClick={() => setAnnotating(a)}
                  disabled={resolving}
                >
                  <Pencil size={14} aria-hidden />
                </button>
              ) : null}
              <button
                type="button"
                className="att-remove"
                data-testid="composer-attachment-remove"
                aria-label={`remove ${a.name}`}
                title="Remove attachment"
                onClick={() => removeAttachment(a.key)}
                disabled={resolving}
              >
                <CloseIcon size={16} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {previewing?.previewUrl ? (
        <ImageLightbox
          url={previewing.previewUrl}
          alt={previewing.name}
          downloadName={previewing.name}
          onClose={() => setPreviewing(null)}
        />
      ) : null}
      {annotating ? (
        <ImageAnnotator
          file={annotating.file}
          onCancel={() => setAnnotating(null)}
          onDone={(file) => {
            replaceAttachmentFile(annotating.key, file);
            setAnnotating(null);
          }}
        />
      ) : null}
      {sketching ? (
        <ImageAnnotator
          onCancel={() => setSketching(false)}
          onDone={(file) => {
            addFiles([file]);
            setSketching(false);
          }}
        />
      ) : null}
      {/* One hidden input (spec/14 § Composer): a SINGLE attach that accepts
          images AND any file — one OS dialog, no duplicate image button. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        data-testid="composer-file-input"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          // Reset so picking the same file again re-fires change.
          e.target.value = '';
        }}
      />
      {dictModeOn ? (
        <div
          className="dictation-status"
          data-testid="dictation-mode-status"
          data-state={dictPending > 0 ? 'transcribing' : 'recording'}
          role="status"
        >
          {dictPending > 0 ? 'Dictating… sending' : 'Dictating…'}
        </div>
      ) : null}
      <div className="composer-row">
        {/* The input and its live-dictation mirror share one positioned box so
            the greyed preview sits exactly over the real text. */}
        <div className={leading ? 'composer-input-wrap has-leading' : 'composer-input-wrap'}>
          {leading ? <div className="composer-leading">{leading}</div> : null}
          {/* Live-dictation preview (spec/07 § Dictation into the composer):
              what is already in the input, in normal ink, plus the host's
              interim transcript GREYED behind a text-transparent textarea, so
              the real input keeps the caret and stays editable throughout.
              Only mounted while there is something to preview. */}
          {showLivePreview ? (
            <div className="composer-live-preview" data-testid="composer-live-preview" aria-hidden>
              <span className="composer-live-committed">{body}</span>
              {body.trim().length > 0 ? ' ' : ''}
              <span className="composer-live-partial" data-testid="composer-live-partial">
                <span aria-hidden>🎤 </span>
                {livePartial}
              </span>
            </div>
          ) : showChipMirror ? (
            // spec/14 § Composer — chips: the same text-transparent-textarea
            // trick as the dictation preview above, generalised: the real
            // input keeps the caret and every editing gesture, and this mirror
            // draws the SAME text back over it, with each completed
            // `/<skill>` wrapped in a little box instead of plain characters.
            <div className="composer-chip-mirror" data-testid="composer-chip-mirror" aria-hidden>
              {renderChipMirror()}
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            className="composer-input"
            data-preview={showLivePreview ? 'true' : undefined}
            data-chips={showChipMirror ? 'true' : undefined}
            data-testid={edit ? 'msg-edit-input' : 'composer-input'}
            /* spec/14 § Copy — no helper text: the prompt names the field and
             stops. It used to trail the send convention, which put a sentence
             of instruction in front of the user on every empty chat; the send
             button's own `Send (↵)` tooltip and the ⌘? cheat-sheet carry that.
             `Reconnecting…` is the one permitted swap — state, not teaching. */
            placeholder={
              suppressPlaceholder ? undefined : offline ? 'Reconnecting…' : placeholderText
            }
            onChange={(e) => {
              setValue(joinQuotes(quotes, e.target.value));
              // Any edit re-opens a menu the user had Esc-dismissed.
              setSlashDismissed(false);
              syncCursor(e.target);
            }}
            onClick={(e) => syncCursor(e.currentTarget)}
            onKeyUp={(e) => syncCursor(e.currentTarget)}
            onSelect={(e) => syncCursor(e.currentTarget)}
            onPaste={onPaste}
            onScroll={(e) => syncMirrors(e.currentTarget)}
            onFocus={() => {
              if (!edit) useComposerDraftStore.getState().setFocused(chatId, true);
            }}
            onBlur={() => {
              // spec/14 § Composer — a draft that arrived from another
              // surface while this composer had focus is held back rather
              // than overwriting text under the cursor; losing focus is what
              // resolves it, taking the newer text if there is one.
              if (edit) return;
              const applied = useComposerDraftStore.getState().setFocused(chatId, false);
              if (applied !== undefined) setValue(applied);
            }}
            onKeyDown={(e) => {
              // A voice note in flight owns ⏎ and esc, ahead of EVERY other
              // binding and whatever has focus (spec/07 ## Voice-input modes). The
              // overlay has no controls of its own and the global window handler
              // stands down inside a text field, so without this a note started
              // from the new-chat mic — which navigates into a chat whose composer
              // auto-focuses — could be neither committed nor cancelled (the user,
              // patch/todo.md: "cannot be ended or cancelled"). The typed text is
              // left untouched: ⏎ commits the NOTE, not the half-written message.
              if (noteActive && (e.key === 'Escape' || e.key === 'Enter')) {
                if (e.key === 'Enter' && (e.shiftKey || e.nativeEvent.isComposing)) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.key === 'Escape') cancelVoiceNote();
                else sendVoiceNote();
                return;
              }
              // spec/14 § Skill autocomplete — Backspace right after a chip
              // removes the whole `/<skill> ` in one press rather than eating
              // it one character at a time. Only for a collapsed caret (a real
              // selection deletes normally, as Backspace always has).
              if (e.key === 'Backspace') {
                const el = e.currentTarget;
                if (el.selectionStart !== null && el.selectionStart === el.selectionEnd) {
                  const chip = chipEndingAt(body, el.selectionStart, knownChipNames);
                  if (chip) {
                    e.preventDefault();
                    setValue(
                      joinQuotes(quotes, body.slice(0, chip.start) + body.slice(el.selectionStart)),
                    );
                    pendingCursorRef.current = chip.start;
                    return;
                  }
                }
              }
              // Skill-menu navigation takes priority over send/stop while open.
              // Only the arrow/complete keys are gated on there being something to
              // navigate: the menu now also opens on an EMPTY result to say so,
              // and swallowing Enter there would leave `/nomatch` unsendable.
              if (showSkillMenu) {
                if (allItems.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSkillIndex((i) => (i + 1) % allItems.length);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSkillIndex((i) => (i - 1 + allItems.length) % allItems.length);
                    return;
                  }
                  // Enter AND Tab both complete the highlighted item. preventDefault
                  // on Tab keeps focus in the composer (no tab-out) — matching an
                  // editor's autocomplete (spec/14 § Skill autocomplete).
                  if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    const picked = allItems[activeSkillIndex];
                    if (picked) completeItem(picked.name, picked.isBuiltin);
                    return;
                  }
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setSlashDismissed(true);
                  return;
                }
              }
              // Esc cancels an open transcribe-mode recording without transcribing
              // (mic toggle session) — before the running-turn Esc so a recording
              // takes priority.
              if (e.key === 'Escape' && dictModeRef.current) {
                e.preventDefault();
                e.stopPropagation();
                stopDictationMode();
                return;
              }
              if (e.key === 'Escape' && !noteMode && micState !== 'idle') {
                e.preventDefault();
                e.stopPropagation();
                cancelRecording();
                return;
              }
              if (e.key === 'Escape' && editingTurn) {
                e.preventDefault();
                e.stopPropagation();
                editingTurn.onCancel();
                return;
              }
              if (e.key === 'Escape' && edit) {
                e.preventDefault();
                e.stopPropagation();
                edit.onCancel();
                return;
              }
              // Esc interrupts the running turn (parity with Claude Code). Scoped to
              // the composer + guarded on `running` so it doesn't clash with the
              // global Esc handlers (dismiss call / close kebab / cancel voice note).
              if (e.key === 'Escape' && running && onStop) {
                e.preventDefault();
                e.stopPropagation();
                onStop();
                return;
              }
              // Chat convention: Enter sends, Shift+Enter inserts a newline. IME
              // composition (e.g. for CJK input) must not be hijacked — Enter there
              // commits the candidate.
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              // ⇧ alone is a newline; ⌘⇧↵ / Ctrl⇧↵ is the keyboard form of the send
              // menu's "Send, interrupt immediately" — send, then promote.
              if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return; // newline
              // An edit is often several lines: bare ↵ is a newline there and only
              // ⌘↵ / Ctrl↵ saves (spec/14 § Keyboard shortcuts).
              if (edit && !isSubmitChord(e)) return;
              e.preventDefault();
              // ↵ and ⌘↵ both just send; mid-turn that queues behind the running
              // turn and does not interrupt it. Only ⌘⇧↵, Stop, Esc and a queued
              // message's ↑ do (spec/04 § Message queueing). An empty composer
              // has nothing to send, so Enter there does nothing.
              handleSubmit(e.shiftKey);
            }}
            // Typing stays possible while the LINK is down (`offline`), and
            // for an existing chat so does sending — it queues and flushes on
            // reconnect (Todoist 6hWrcpCQFqXGJpF6). A missing Claude
            // credential is the one case that disables the field itself:
            // that turn can never run at all.
            disabled={claudeDisconnected}
            {...(claudeDisconnected
              ? {
                  title: `${accountModel?.startsWith('openai/') ? 'Codex' : 'Claude'} isn’t connected. Connect in Settings.`,
                }
              : {})}
            rows={1}
          />
        </div>
        {/* spec/14 § Copy — no helper text: an icon-only control's tooltip NAMES
            it in a word or two; it is never a sentence explaining what it does
            (Tom, `patch/todo.md` — "composer tooltips are whole sentences,
            should just name the button"). Where a control has a shortcut the
            name carries it in the same monospace convention as the cheat-sheet,
            which is discoverability, not explanation. The one wordy tooltip
            left is the offline/unavailable case: that states a REASON the
            control is dead, which nothing else on screen says. */}
        <div className="composer-actions">
          {edit ? null : (
            <>
              <button
                type="button"
                className="attach-btn"
                data-testid="attach-btn"
                aria-label="attach file"
                title="Attach"
                onClick={() => fileInputRef.current?.click()}
                disabled={linkOrCredentialBlocked || resolving}
              >
                <Paperclip size={ICON_SIZE} aria-hidden />
              </button>
              <button
                type="button"
                className="attach-btn"
                data-testid="sketch-btn"
                aria-label="sketch"
                title="Sketch"
                onClick={() => setSketching(true)}
                disabled={linkOrCredentialBlocked || resolving}
              >
                <PenLine size={ICON_SIZE} aria-hidden />
              </button>
            </>
          )}
          <button
            type="button"
            className={`voice-note-btn ${noteActive || micState !== 'idle' || dictModeOn ? 'active' : ''}${micState === 'transcribing' ? ' busy' : ''}`}
            data-testid="voice-note-btn"
            aria-label={noteMode ? 'voice note' : 'dictate into message'}
            aria-pressed={noteActive || micState !== 'idle' || dictModeOn}
            title={
              !offline && !hostOnline
                ? 'Voice unavailable while the agent is offline (audio can’t be queued)'
                : noteMode
                  ? shortcutTitle('Voice note', chordGlyphs(dictateChord))
                  : micState === 'transcribing'
                    ? 'Transcribing…'
                    : shortcutTitle('Dictate', chordGlyphs(dictateChord))
            }
            // Only the primary button dictates: a right-click opens the mic
            // menu (onContextMenu), and its own mousedown must not also start
            // a hold-to-talk recording.
            onMouseDown={(e) => {
              if (e.button === 0) onMicDown(e.timeStamp);
            }}
            onMouseUp={(e) => {
              if (e.button === 0) onMicUp(e.timeStamp);
            }}
            onContextMenu={(e) => {
              if (voiceDisabled || noteMode || noteActive || micState !== 'idle' || dictModeOn) {
                e.preventDefault();
                return;
              }
              micMenu.openAt(e);
            }}
            onMouseLeave={(e) => {
              // Pointer left while holding: commit (release-sends / release-dictates).
              if (pressAt.current !== null) onMicUp(e.timeStamp);
            }}
            disabled={voiceDisabled || micState === 'transcribing'}
          >
            <Mic size={ICON_SIZE} aria-hidden />
          </button>
          {edit ? null : (
            <>
              {/* Call (spec/14 § Composer) — starts a sustained voice call for
              this chat. Moved here from the chat header (§ Chat panel
              header): attach, dictate and call read as one family of
              composer-adjacent actions rather than splitting call off into
              the header's own icon rail. */}
              <button
                type="button"
                className={`call-btn${onCall ? ' live' : ''}`}
                data-testid="call-btn"
                data-live={onCall ? 'true' : undefined}
                aria-pressed={onCall}
                aria-label={onCall ? 'end call' : 'call'}
                title={
                  onCall
                    ? 'End call'
                    : voiceDisabled
                      ? 'Voice unavailable while the agent is offline'
                      : 'Call'
                }
                onClick={() => void handleCall()}
                disabled={voiceDisabled && !onCall}
              >
                <Phone size={ICON_SIZE} aria-hidden />
              </button>
              {/* Meeting (meeting mode) — this chat listens to a meeting and keeps
              live notes beside the conversation. Pressing it again ends it. */}
              {!hasMeetingButton ? null : (
                <span className="mm-setup-anchor">
                  <button
                    type="button"
                    className={`call-btn meeting-btn${inMeeting ? ' mm-live' : ''}`}
                    data-testid="meeting-btn"
                    aria-pressed={inMeeting}
                    aria-label={inMeeting ? 'end meeting' : 'meeting'}
                    title={inMeeting ? 'End meeting' : 'Meeting'}
                    onClick={() =>
                      onStartMeeting
                        ? onStartMeeting()
                        : inMeeting
                          ? endMeeting(chatId)
                          : void beginMeeting(chatId)
                    }
                    disabled={voiceDisabled && !inMeeting}
                  >
                    <AudioLines size={ICON_SIZE} aria-hidden />
                  </button>
                  <MeetingSetupPopover chatId={chatId} />
                </span>
              )}
              {/* Approval mode (spec/14 § Composer — Approval mode): the mode this
              chat's next turn will use, last in the utility group so it reads
              against the turn about to be sent without displacing stop/send from
              the right edge. Options are the SDK's own mode names — the value is
              passed through to it verbatim. Disabled while the link is down —
              `getActiveWs()` is null then, and a select that silently dropped the
              change would be exactly the fallback spec/12 forbids. */}
              {chatId === 'new' ? null : (
                // A plain <select> here draws with the OS's own chrome — a native
                // arrow glyph and reserved gutter that read as a different control
                // from the model pill beside it (spec/14 § Composer — Approval
                // mode wants the two to look like one family). `appearance: none`
                // (index.css) drops that chrome; the caret below stands in for it,
                // coloured through the sibling combinator so it dims and lights up
                // exactly as the select's own text does.
                <div className="permission-mode-wrap">
                  <select
                    className="permission-mode"
                    data-testid="permission-mode"
                    aria-label="Approval mode"
                    title="Approval mode"
                    value={permissionMode ?? ''}
                    disabled={offline}
                    onChange={(e) => {
                      getActiveWs()?.send({
                        type: 'chat.settings',
                        chatId,
                        permissionMode: e.target.value as PermissionMode,
                      });
                    }}
                  >
                    {permissionMode === undefined ? (
                      <option value="" disabled>
                        Approval mode
                      </option>
                    ) : null}
                    {PERMISSION_MODES.filter(
                      (m) => offeredModes.includes(m) || m === permissionMode,
                    ).map((m) => (
                      <option key={m} value={m}>
                        {permissionModeLabel(m)}
                        {offeredModes.includes(m) ? '' : ' (not on this model)'}
                      </option>
                    ))}
                  </select>
                  <span className="permission-mode-caret" aria-hidden>
                    ▾
                  </span>
                </div>
              )}
              <ChatModelControl chatId={chatId} />
              <EffortControl chatId={chatId} />
              {/* spec/14 § Composer — context ring, immediately left of stop/send. */}
              <ContextRing chatId={chatId} />
            </>
          )}
          {edit ? (
            <>
              <button
                type="button"
                className="msg-edit-cancel"
                data-testid="msg-edit-cancel"
                onClick={edit.onCancel}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="msg-edit-save"
                data-testid="msg-edit-save"
                disabled={!edit.allowEmpty && !hasContent}
              >
                Save
                <span className="btn-chord" data-testid="msg-edit-save-chord" aria-hidden="true">
                  {shortcutLabel('⌘↵')}
                </span>
              </button>
            </>
          ) : showStop ? (
            <button
              type="button"
              className="stop-btn"
              data-testid="stop-btn"
              aria-label="stop turn"
              title={shortcutTitle('Stop', 'Esc')}
              onClick={onStop}
              disabled={offline}
            >
              <Square size={ICON_SIZE} aria-hidden />
            </button>
          ) : checking ? (
            <button
              type="button"
              className="send-btn composer-checking-btn"
              data-testid="composer-checking"
              aria-label={
                checkingHookNames && checkingHookNames.length > 0
                  ? `checking: ${checkingHookNames.join(', ')}`
                  : 'checking'
              }
              title={
                checkingHookNames && checkingHookNames.length > 0
                  ? `Checking… (${checkingHookNames.join(', ')})`
                  : 'Checking…'
              }
              disabled
            >
              Checking…
            </button>
          ) : (
            <button
              type="submit"
              className="send-btn"
              data-testid="send-btn"
              aria-label="send message"
              /* `↵` is the primary key and `⌘↵` also works — name the primary one
                 (Tom, `patch/todo.md` — "nothing tells you enter sends"). */
              title={
                editingTurn
                  ? shortcutTitle('Save edit', '↵')
                  : running
                    ? shortcutTitle('Queue', '↵')
                    : shortcutTitle('Send', '↵')
              }
              disabled={sendBlocked || resolving || !hasContent}
              onContextMenu={sendMenu.openAt}
            >
              <Send size={ICON_SIZE} aria-hidden />
            </button>
          )}
        </div>
      </div>
      <ContextMenu
        anchor={micMenu.anchor}
        items={micMenuItems}
        onClose={micMenu.close}
        label="Dictation"
        testId="mic-menu"
      />
      <ContextMenu
        anchor={sendMenu.anchor}
        items={sendMenuItems}
        onClose={sendMenu.close}
        label="Send options"
        testId="send-menu"
      />
      {scheduling ? (
        <div className="composer-schedule" data-testid="schedule-send">
          <input
            type="datetime-local"
            data-testid="schedule-at"
            aria-label="send at"
            value={scheduling.at}
            onChange={(e) => setScheduling({ at: e.target.value, error: null })}
          />
          <button
            type="button"
            data-testid="schedule-confirm"
            onClick={() => void confirmSchedule()}
          >
            Schedule
          </button>
          <button type="button" data-testid="schedule-cancel" onClick={() => setScheduling(null)}>
            Cancel
          </button>
          {scheduling.error ? (
            <span role="alert" data-testid="schedule-error">
              {scheduling.error}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* spec/14 § Skill autocomplete — hovering (desktop) or tapping (web
          touch) a chip shows the SAME preview as the `/` list: full
          description, the rest of the frontmatter, an Edit link. Portalled so
          it floats above the composer rather than being clipped by it. */}
      {chipPreview
        ? createPortal(
            <div
              ref={chipPreviewRef}
              className="composer-chip-preview-popover"
              data-testid="composer-chip-preview-popover"
              onMouseEnter={cancelChipPreviewClose}
              onMouseLeave={() => scheduleChipPreviewClose()}
              style={{
                position: 'fixed',
                top: chipPreviewPos?.top ?? 0,
                left: chipPreviewPos?.left ?? 0,
                visibility: chipPreviewPos ? 'visible' : 'hidden',
              }}
            >
              <SkillPreviewPanel
                item={{
                  name: chipPreview.name,
                  isBuiltin: chipPreview.isBuiltin,
                  description: chipPreview.isBuiltin
                    ? BUILTIN_COMMANDS.find((c) => c.name === chipPreview.name)?.description
                    : skillDescriptions[chipPreview.name],
                }}
                paths={skillPaths}
                frontmatter={skillFrontmatter}
                hostId={hostId ?? ''}
                folder={trimmedFolder}
              />
            </div>,
            document.body,
          )
        : null}
    </form>
  );
});
