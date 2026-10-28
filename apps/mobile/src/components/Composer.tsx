// Chat-detail composer: multi-line text input + attach + mic + send.
//
// The mic DICTATES into this composer's own text input (spec/07 § "Dictation
// into the composer"): tap toggles recording, press-and-hold is hold-to-talk.
// Either way, the recognised text lands in the draft, editable, and is NEVER
// auto-sent — there is no overlay, matching web/desktop's composer mic. This
// is distinct from a voice NOTE (chat-row long-press, Voice tab, Manager row),
// which auto-sends as a new chat turn via the VoiceNoteOverlay (lib/voiceNote.ts)
// — the composer mic does not use that path at all. Starting a sustained voice
// CALL is a separate control (the phone icon in the chat-detail header).
//
// LIVE DICTATION (Todoist 6hHGqGVpJqfcXPmm — "voice message on mobile should
// show live transcription inside the text input"): while recording, the
// interim transcript (`lib/dictation.ts`, fed by the host's
// `audio.transcript_partial`) renders inside the input in grey, updating live
// as the user talks. Send while dictating ends it and sends typed + heard.
// On gesture-end it is replaced by the committed draft text — editable and
// sendable like anything else typed. Starting a dictation puts the keyboard
// away (there is nothing to type while talking) and a listening strip above
// the input names the state and counts the time. The mic lives inside the text
// field's bottom-right corner and pulses red while it is listening; a Cancel
// (✕) takes the attach buttons' place at the left of the action row while a
// dictation is in flight, to discard it without transcribing — well away from
// the mic, so stopping and cancelling are never one slip apart
// (`lib/dictation.ts` `finish(false)`) — read that file's header before touching this: the whole
// point of its design is that a fast tap/hold-release NEVER silently drops the
// note, unlike the reverted streaming attempt it replaces.
//
// A hold session ends on a genuine finger LIFT, and the commit therefore hangs
// off `onTouchEnd`/`onTouchCancel` — the raw View touch events, which
// Pressability does not claim — NOT off `onPressOut`. React Native fires
// `onPressOut` on LEAVE_PRESS_RECT as well as on release
// (`Pressability.js`: RESPONDER_ACTIVE_LONG_PRESS_IN + LEAVE_PRESS_RECT ->
// ..._OUT -> `_deactivate` -> onPressOut), so a few px of finger drift on a
// 44px button — or this composer growing under the finger the moment the
// dictation preview appears — used to commit the clip half a second in, mid
// word, with no feedback whatsoever. Do not put the commit back on
// `onPressOut`.
//
// And a dictation that yields no text always SAYS so, naming which of the
// three things happened (nothing captured / too short / no speech heard). An
// empty result used to be a silent no-op, which is why the only bug report it
// ever produced was the word "broken".
//
// Attachments (spec/15 § Composer — "Attachments (images + files)"): three
// clear buttons — a camera icon takes a photo now, an image icon opens the
// photo library, the paperclip opens the OS file picker (any type). There is
// NO dedicated paste button. Paste is the input's own: long-press → Paste puts
// text in as plain text, and an image on the clipboard — or one a keyboard
// inserts (Gboard GIFs, stickers) — is attached like a picked one, through the
// PatchPaste native module's image listener on the input (lib/nativePaste.ts).
// Attached images are DOWNSCALED/compressed before upload (longest
// edge ~1568px, JPEG) so they're within Claude's vision limits. Attachments add
// removable thumbnails above the input that upload with the message on send and
// render inline in the stream (tapping an image opens an in-app zoomable
// viewer). Sending with attachments reacts at once, exactly like a text send:
// the composer clears and the message appears in the stream straight away,
// drawn from the local files and marked `Uploading 1/3` until every upload has
// landed, and only then is the turn sent. The upload pipeline — ordering,
// failure (`Not uploaded`, Retry / ×) and all — lives in lib/sendQueue.ts, not
// here, so it survives this composer unmounting.
//
// The action row, left to right (spec/15 § Composer — the user's layout):
//   [camera][image][file][mic] … [model pill][padlock][Send | Stop]
// The model pill names the model the NEXT message runs on and changes it with
// the same `chat.model_request` web's header crumb sends. The padlock is the
// chat's permission mode — its icon says which mode, bypass is an open lock in
// the danger colour — and opens the mode list, greying out modes the chat's
// model cannot run (web's `permissionModesFor` rule). While a turn is running
// an EMPTY composer's Send becomes Stop (`chat.stop_request`, as web's stop
// button); typing brings Send back, and that send is QUEUED by the host behind
// the running turn exactly as a web send mid-turn is. On a 360dp phone the
// pill is the one control that shrinks, so Send/Stop is never pushed off.
//
// Send + mic are daemon-dependent controls (spec/12 § Daemon-offline UX): when
// the WS is down or the host is offline they render visibly disabled with a
// reason that names the cause — never a dead button, never a silent no-op.

import React from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  Mic,
  ArrowUp,
  X,
  FileText,
  Square,
  Lock,
  LockOpen,
  FilePen,
  ClipboardList,
  Sparkles,
  Pencil,
  Plus,
  Gauge,
  UserRound,
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {
  harnessForModel,
  providerBuiltinCommands,
  type AttachmentRef,
  type EffortLevel,
  type PermissionMode,
} from '@patch/wire';
import { AnchoredMenu } from './AnchoredMenu';
import { ImageAnnotatorModal, type AnnotatedImage } from './ImageAnnotatorModal';
import { ModelPicker } from './ModelPicker';
import { ProviderSwitchModal } from './ProviderSwitchModal';
import { suppressProviderSwitchWarningOrFalse } from '../lib/preferences';
import { useSettingsStore } from '../stores/settingsStore';
import {
  PERMISSION_MODE_ORDER,
  offeredPermissionModes,
  permissionModeLabel,
  permissionModeShortLabel,
} from '../lib/permissionModes';
import { receiveImagePaste } from '../lib/nativePaste';
import * as FileSystem from 'expo-file-system';
import { extractLongPaste, pastedTextName } from '../lib/longPaste';
import {
  filterSkills,
  activeSlashToken,
  findChipTokens,
  chipEndingAt,
  spliceCompletion,
  type ChipToken,
} from '../lib/skillAutocomplete';
import { SkillPreviewSheet } from './SkillPreviewSheet';
import { getLastUsedSkill, setLastUsedSkill, orderSkillsByLastUsed } from '../lib/lastUsedSkill';
import { joinQuotes, splitQuotes } from '../lib/composerQuotes';
import { getComposerDraft, setComposerDraft, useComposerDraftStore } from '../lib/composerDraft';
import { useNewChatDraftStore } from '../stores/newChatDraftStore';
import { radii, space, textMin, typography, useTheme } from '../lib/theme';
import { getWs } from '../api/ws';
import { api } from '../api/rest';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';
import {
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  dictationMaxHeight,
} from '../lib/composerHeight';
import { startDictation, warmDictation, type DictationHandle } from '../lib/dictation';
import { dictationEngineFor } from '../lib/dictationEngine';
import { startDictationMode, type DictationModeHandle } from '../lib/dictationMode';
import { voiceKeyRefusal } from '../lib/voiceKeys';
import { usePresenceStore } from '../stores/presenceStore';
import { hostControlsDisabled, hostControlDisabledReason } from '../lib/connection';
import { sendMessage, type OutgoingFile } from '../lib/sendQueue';
import { adviseNotes, checkHooks } from '../lib/hookCheck';
import { HookBlockSheet } from './HookBlockSheet';
import { ContextRing } from './ContextRing';
import { runSlashCommand, SLASH_COMMANDS } from '../lib/slashCommands';

const BUILTIN_COMMAND_NAMES: string[] = SLASH_COMMANDS.map((c) => c.name);
import type { HookRunResult } from '@patch/wire/hooks';
import { StatusDot } from './CallParts';
import { ensurePermission } from '../lib/permissionGate';
import { enablePushNotifications } from '../lib/push';
import {
  NO_ATTACHMENTS,
  useComposerAttachmentStore,
  waitForAttachmentUpload,
  type AttachmentTarget,
  type PendingAttachment,
} from '../stores/composerAttachmentStore';

interface Props {
  chatId: string;
  /** Put the cursor in the input on mount (spec/15 § Composer — opening a chat). */
  autoFocus?: boolean;
  /** The chat's folder — sources the skill autocomplete (`/` menu). */
  folder?: string;
  /** Test seam: inject a dictation-session factory in place of `lib/dictation`. */
  dictationFactory?: typeof startDictation;
  /** Test seam: inject a dictation-mode (long-press → Keep dictating) session factory. */
  dictationModeFactory?: typeof startDictationMode;
  /**
   * The new-chat screen's composer (spec/15 § New chat flow): `chatId` is then
   * only the draft key, and the chat to send into is resolved on send — the
   * screen creates it (or hands back the one it already created). `null` means
   * it could not, and the screen has already said why: the text and the
   * attachments stay put for a retry.
   */
  sendTarget?(): Promise<string | null>;
  /**
   * Chat id the live dictation preview binds to when `chatId` is only a draft
   * key (new-chat screen): `draftDictationChatId(hostId)`. `null`: no host yet.
   */
  dictationChatId?: string | null;
  /** A send into `chatId` went out (echoed; delivery follows its uploads). */
  onSent?(chatId: string): void;
  /**
   * Edit mode (spec/15 § Editing a queued message): this composer edits the
   * text of a message already in the stream instead of composing a new one —
   * the same input (`/` skill menu and chips, dictation, quotes, auto-grow),
   * minus attachments, model, approval mode, context ring and drafts, with
   * Cancel / Save in place of Send. `onSave` gets the trimmed text, which may
   * be empty (the caller decides whether that is a remove).
   */
  edit?: {
    initial: string;
    onChange(text: string): void;
    onSave(text: string): void;
    onCancel(): void;
  };
}

// One glyph size across the action buttons so they read as a matched set and
// the mic is optically centred against its sibling (spec item 1). 36, not 40:
// the row carries seven controls now, and on a 360dp phone every 4px of each
// is width the model pill needs; the hit slop below keeps the touch target
// bigger than the drawn button.
const ICON_SIZE = 20;
const ACTION_SIZE = 36;
/** Extra touchable margin around the mic/attach targets. */
const MIC_HIT_SLOP = 12;
// The mic sits INSIDE the text field, at its bottom-right corner, so it rides
// with the last line as the field grows. Drawn small and in the quiet ink at
// rest; the field's right padding keeps text from running under it.
const FIELD_MIC_SIZE = 32;
const FIELD_MIC_ICON_SIZE = 18;
const FIELD_MIC_INSET = (COMPOSER_MIN_HEIGHT - FIELD_MIC_SIZE) / 2;
const FIELD_PAD_RIGHT = FIELD_MIC_SIZE + FIELD_MIC_INSET + space.xs;
// The + (what goes into the message) mirrors the mic at the field's
// bottom-left, so the text keeps clear of it the same way.
const FIELD_PAD_LEFT = FIELD_MIC_SIZE + FIELD_MIC_INSET + space.xs;
// Send/Stop are the only action-row controls that paint a filled circle
// rather than an outline glyph, so at the shared 36px token they read heavier
// than their neighbours (Todoist 6hf2JM6695c7rhJ6 — "looks big even if it
// isn't"). Paint the circle smaller and make up the difference in hit slop,
// so the touch target still matches every other 36px control in the row.
const SEND_STOP_VISUAL_SIZE = 30;
const SEND_STOP_HIT_SLOP = (ACTION_SIZE - SEND_STOP_VISUAL_SIZE) / 2;
const SEND_ICON_SIZE = 18;
const STOP_ICON_SIZE = 14;
/** How long a send holds the busy styling waiting for the host to confirm
 * the turn as running, before it gives up and settles (see `pendingSend`). */
export const PENDING_SEND_TIMEOUT_MS = 5000;
/**
 * How far the finger may wander during a press before React Native calls the
 * press rect left. Deliberately far wider than the button: a hold-to-talk
 * gesture lasts as long as a sentence, and the finger WILL move over that
 * time. Keeping the press rect generous means Pressability never declares a
 * LEAVE_PRESS_RECT mid-hold, so the pressed styling doesn't flicker either.
 */
const MIC_PRESS_RETENTION = 80;

/**
 * How long the pill waits for the host to confirm a model change before it
 * says the switch did not happen — web's `MODEL_CONFIRM_TIMEOUT_MS`, for the
 * same reason: a host too old to know `chat.model_request` never answers, and
 * a pill left naming a model the chat is not on is a silent failure.
 */
export const MODEL_CONFIRM_TIMEOUT_MS = 8000;

const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** The padlock's glyph for each mode: what the next turn is allowed to do. */
export function permissionModeIcon(mode: PermissionMode | string): typeof Lock {
  switch (mode) {
    case 'acceptEdits':
      return FilePen;
    case 'plan':
      return ClipboardList;
    case 'auto':
      return Sparkles;
    case 'bypassPermissions':
      return LockOpen;
    default:
      return Lock;
  }
}

export function Composer({
  chatId,
  dictationChatId,
  folder,
  dictationFactory,
  dictationModeFactory,
  sendTarget,
  onSent,
  autoFocus,
  edit,
}: Props): React.ReactElement {
  const colors = useTheme();
  // The new-chat screen's composer (`sendTarget` set) has no chat yet, so
  // `chatId` is a new-chat DRAFT's own id, not a chatId — its text is synced
  // through the new-chat-draft store (spec/14 § New chat drafts), which also
  // carries the draft's folder/host/model, rather than the per-chat
  // composer-draft store every other composer uses.
  const isNewChatDraft = sendTarget !== undefined;
  const getDraftText = (id: string): string =>
    isNewChatDraft ? (useNewChatDraftStore.getState().get(id)?.text ?? '') : getComposerDraft(id);
  const setDraftText = (id: string, text: string): void => {
    if (isNewChatDraft) useNewChatDraftStore.getState().update(id, { text });
    else setComposerDraft(id, text);
  };
  const setDraftFocused = (id: string, isFocused: boolean): string | undefined =>
    isNewChatDraft
      ? useNewChatDraftStore.getState().setFocused(id, isFocused)
      : useComposerDraftStore.getState().setFocused(id, isFocused);
  // spec/15 § Composer — unsent text belongs to the chat it was typed in, so it
  // is seeded from that chat's stored draft and written back as it is typed.
  const [draft, setDraft] = React.useState(() => (edit ? edit.initial : getDraftText(chatId)));
  // An editor owns its text: nothing it types reaches the chat's unsent draft.
  const editRef = React.useRef(edit);
  editRef.current = edit;
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  // spec/15 § Composer — quotes: leading `> ` blocks of the draft are cards
  // above the input; the input (cursor, `/` menu, chips) works on `body` only.
  const { quotes, body } = React.useMemo(() => splitQuotes(draft), [draft]);
  // Persist SYNCHRONOUSLY with the state update rather than from an effect: an
  // effect keyed on [chatId, draft] fires once with the new chatId and the
  // previous chat's text still in state, writing chat A's draft onto chat B.
  const updateDraft = React.useCallback(
    (next: string | ((cur: string) => string)): void => {
      const value = typeof next === 'function' ? next(draftRef.current) : next;
      draftRef.current = value;
      setDraft(value);
      if (editRef.current) editRef.current.onChange(value);
      else setDraftText(chatId, value);
    },
    [chatId],
  );
  // Re-seed if this composer is reused for a different chat (the screen is not
  // guaranteed to remount). Never writes, so it cannot cross-contaminate.
  React.useEffect(() => {
    if (editRef.current) return;
    const stored = getDraftText(chatId);
    draftRef.current = stored;
    setDraft(stored);
  }, [chatId]);
  // Text put into this chat's draft from OUTSIDE the composer (a queued-message
  // edit that lost the race, spec/04 § Edit) shows up here unless the user is
  // typing — a focused composer is never overwritten under the cursor.
  // Subscribed imperatively: a hook selector re-rendered the composer on the
  // echo of every keystroke's own write to this store.
  React.useEffect(() => {
    if (editRef.current) return;
    const apply = (): void => {
      const stored = isNewChatDraft
        ? (useNewChatDraftStore.getState().drafts[chatId]?.text ?? '')
        : (useComposerDraftStore.getState().drafts[chatId] ?? '');
      if (stored === draftRef.current) return;
      const focused = isNewChatDraft
        ? useNewChatDraftStore.getState().focused[chatId]
        : useComposerDraftStore.getState().focused[chatId];
      if (focused) return;
      draftRef.current = stored;
      setDraft(stored);
    };
    apply();
    return isNewChatDraft
      ? useNewChatDraftStore.subscribe(apply)
      : useComposerDraftStore.subscribe(apply);
  }, [chatId]);
  // Held per draft key in a store rather than here, so the share sheet can
  // drop a shared file into this composer (spec/15 § Share into Patch).
  // Step 3 of 3 (spec/14 & spec/15 § Composer → Attachments) — `chatId` IS
  // the draft key either way here (an existing chat's real chatId, or a
  // new-chat draft's own id), but the two upload to different routes.
  const attachmentTarget: AttachmentTarget = isNewChatDraft
    ? { kind: 'new-chat-draft', draftId: chatId }
    : { kind: 'chat', chatId };
  const storedAttachments = useComposerAttachmentStore((s) => s.byKey[chatId] ?? NO_ATTACHMENTS);
  const attachments = edit ? NO_ATTACHMENTS : storedAttachments;
  // This chat's row — the mode, model, host and activity the controls on the
  // right of the action row read, and the host the skill list below is fetched
  // from. Undefined until the roster or the stream has named the chat; the
  // pill and padlock are on screen regardless (the options under the input are
  // always available) but read empty until then rather than inventing a model
  // or a mode nobody set. Only the new-chat screen (`sendTarget`) omits them —
  // its setup rows above own the choice.
  const row = useChatStore((s) => s.chats[chatId]);
  // A new-chat send waiting on the chat to be created (`sendTarget`). Holds the
  // send button busy — a spinner in the active colour, so the tap visibly did
  // something. Attachment uploads never hold the composer: the message is in
  // the stream, counting them, the moment Send is pressed (lib/sendQueue.ts).
  const [resolving, setResolving] = React.useState(false);
  // A send into an existing chat clears the draft synchronously, but the host
  // confirming the turn as `running` — what lets Stop take over — arrives a
  // moment later over the socket. Without this, that gap reads as the send
  // button going dead (Todoist 6hf2JM6695c7rhJ6): empty draft + not yet
  // running looks identical to nothing-to-send. Holds the busy styling across
  // that gap, bounded so a send that never gets a `running` back (an offline
  // queue) still settles instead of spinning forever.
  const [pendingSend, setPendingSend] = React.useState(false);
  // spec/20-hooks.md — Send reads Checking… while the hook check is in flight;
  // a `block` parks the message here until the user picks Use suggestion /
  // Edit / Send anyway.
  const [hookChecking, setHookChecking] = React.useState(false);
  const [hookBlock, setHookBlock] = React.useState<{
    text: string;
    pending: PendingAttachment[];
    results: HookRunResult[];
    /** The draft as it stood when Send was pressed (see `sendNow`). */
    draftAtSend: string;
  } | null>(null);
  const pendingSendTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPendingSendTimeout = (): void => {
    if (pendingSendTimeoutRef.current !== null) {
      clearTimeout(pendingSendTimeoutRef.current);
      pendingSendTimeoutRef.current = null;
    }
  };
  React.useEffect(() => () => clearPendingSendTimeout(), []);

  // Skill autocomplete (spec/15 § Composer): typing `/` opens a list of the
  // folder's skills, filtered as you type, anywhere in the draft it begins a
  // word — not only when the draft is nothing else. Active only while the
  // token AT THE CURSOR is still open (no closing space yet); tap a row to
  // complete. Skills come from `api.skills(folder)`.
  const [skills, setSkills] = React.useState<string[]>([]);
  const [skillDescriptions, setSkillDescriptions] = React.useState<Record<string, string>>({});
  const [skillFrontmatter, setSkillFrontmatter] = React.useState<
    Record<string, Record<string, string>>
  >({});
  const [skillPaths, setSkillPaths] = React.useState<Record<string, string>>({});
  // Where the cursor sits, kept in sync via the TextInput's own
  // `onSelectionChange` — needed to tell which token (if any) the cursor is
  // currently in, wherever in the draft that is.
  // Paired with the text it was measured against: `updateDraft` and
  // `setCursorState` are two separate `setState` calls from the same
  // handler, and this test renderer (unlike a real device) does not always
  // commit them in the same pass — a render can briefly see the NEW draft
  // with the OLD cursor position. Deriving `cursorPos` with a fallback to
  // "end of the current draft" whenever the pairing is stale makes that
  // window harmless instead of transiently misreading `slashActive` (which
  // used to let the chip-priming background fetch fire a beat early, on a
  // stale false, stealing the call a mocked test's `mockImplementationOnce`
  // meant for the real one).
  const [cursorState, setCursorState] = React.useState({ text: '', pos: 0 });
  const cursorPos = cursorState.text === body ? cursorState.pos : body.length;
  // Only `cursorPos` (the selection START) drives rendering/menu state; the
  // END is only needed to tell a collapsed cursor from a real selection for
  // the Backspace-removes-a-chip gesture, so it's a plain ref.
  const selectionEndRef = React.useRef(0);
  const activeToken = activeSlashToken(body, cursorPos);
  const slashQuery = activeToken?.query ?? null;
  const slashActive = activeToken !== null;
  const trimmedFolder = (folder ?? '').trim();
  React.useEffect(() => {
    // Re-read on EVERY open, not once per folder: the list lives on the host's
    // filesystem and changes there must show up on the next `/`. Typing more of
    // the query does not refetch (`slashQuery` is not a dependency), and the
    // last loaded list stays on screen while the new one is in flight. NO
    // FALLBACK: a failed fetch surfaces an error rather than a silently empty
    // list.
    if (!slashActive || trimmedFolder === '' || !row?.hostId) return;
    let live = true;
    void api
      .skills(trimmedFolder, row.hostId)
      .then((r) => {
        if (!live) return;
        setSkills(r.skills ?? []);
        setSkillDescriptions(r.descriptions ?? {});
        setSkillFrontmatter(r.frontmatter ?? {});
        setSkillPaths(r.paths ?? {});
      })
      .catch((e) => {
        if (live) useUiStore.getState().pushError(`skills unavailable: ${(e as Error).message}`);
      });
    return () => {
      live = false;
    };
  }, [slashActive, trimmedFolder, row?.hostId]);
  // spec/15 § Skill autocomplete — chips: a completed `/<skill>` must be
  // recognised (and rendered as a chip, with its preview reachable) even
  // before `/` has ever been opened this session — e.g. reopening a chat
  // whose draft already holds one. Primed in the background the first time
  // the draft contains a `/` at all, once per folder; skipped whenever
  // `slashActive` (the interactive fetch above already covers that open —
  // firing both on the very first `/` typed would double-fetch). Marked
  // "primed" only on SUCCESS: an attempt that gets superseded before it
  // resolves must not block a later, real one from ever trying (see
  // packages/web/src/components/Composer.tsx's identical guard for why).
  const chipFetchPrimedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (trimmedFolder === '' || slashActive || !row?.hostId) return;
    if (chipFetchPrimedRef.current === trimmedFolder) return;
    if (!draft.includes('/')) return;
    let live = true;
    void api
      .skills(trimmedFolder, row.hostId)
      .then((r) => {
        if (!live) return;
        chipFetchPrimedRef.current = trimmedFolder;
        setSkills(r.skills ?? []);
        setSkillDescriptions(r.descriptions ?? {});
        setSkillFrontmatter(r.frontmatter ?? {});
        setSkillPaths(r.paths ?? {});
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [trimmedFolder, draft, slashActive, row?.hostId]);
  // The skill last completed in this folder sorts to the top (spec/15 § Skill
  // autocomplete) — ordering only, applied AFTER the typed prefix filter.
  const filteredSkills =
    slashQuery !== null
      ? [
          ...orderSkillsByLastUsed(
            filterSkills(skills, slashQuery),
            getLastUsedSkill(trimmedFolder),
          ),
          // Built-in commands (lib/slashCommands.ts) follow the folder's skills, as on web.
          ...filterSkills(
            BUILTIN_COMMAND_NAMES.filter((n) => !skills.includes(n)),
            slashQuery,
          ),
        ]
      : [];
  const showSkillMenu = slashActive && filteredSkills.length > 0;
  // The provider's own commands win over a same-named skill (the CLI handles
  // them first), so such a skill is shown red and cannot be completed; typed,
  // the token reads amber as a command. Patch's own commands are exempt.
  const providerCommands = React.useMemo(
    () =>
      new Set(
        [...providerBuiltinCommands(row?.model)].filter((n) => !BUILTIN_COMMAND_NAMES.includes(n)),
      ),
    [row?.model],
  );
  // Every name a chip can legitimately be: the folder's skills. The built-in
  // commands (lib/slashCommands.ts) are offered in the list but are not
  // chipped — they run instead of sending, so there is no skill to preview.
  const knownChipNames = React.useMemo(
    () => new Set([...skills, ...providerCommands]),
    [skills, providerCommands],
  );
  const chipTokens = React.useMemo(
    () => findChipTokens(body, knownChipNames),
    [body, knownChipNames],
  );
  const [previewSkill, setPreviewSkill] = React.useState<{
    name: string;
    description: string | undefined;
  } | null>(null);
  /** The draft text with every completed `/<skill>` swapped for a boxed,
   *  tappable chip (spec/15 § Skill autocomplete — tapping shows the same
   *  preview the `/` list would). */
  function renderChipMirror(): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    chipTokens.forEach((chip: ChipToken, i: number) => {
      if (chip.start > cursor) {
        nodes.push(<Text key={`t${i}`}>{body.slice(cursor, chip.start)}</Text>);
      }
      nodes.push(
        <Text
          key={`c${i}`}
          testID="composer-chip"
          onPress={() =>
            setPreviewSkill({ name: chip.name, description: skillDescriptions[chip.name] })
          }
          style={{
            backgroundColor: colors.divider,
            color: providerCommands.has(chip.name) ? colors.amber : colors.leaf,
            borderRadius: 4,
          }}
        >
          {`/${chip.name}`}
        </Text>,
      );
      cursor = chip.end;
    });
    if (cursor < body.length) nodes.push(<Text key="tail">{body.slice(cursor)}</Text>);
    return nodes;
  }
  const completeSkill = (name: string): void => {
    if (skills.includes(name) && providerCommands.has(name)) return;
    if (activeToken === null) return;
    const { text, cursor } = spliceCompletion(body, activeToken.start, cursorPos, name);
    updateDraft(joinQuotes(quotes, text));
    pendingCursorRef.current = cursor;
    // Remembered per folder so the next `/` defaults to it.
    setLastUsedSkill(trimmedFolder, name);
  };
  const conn = usePresenceStore((s) => s.connection);
  const daemon = usePresenceStore((s) => s.daemon);
  // Two distinct gates (spec/12 § Daemon-offline UX): text + send stay usable
  // whenever the WS link is up — a message sent while the host is offline is
  // QUEUED (buffered + tracked) and delivered on reconnect, never blocked.
  // Attach + voice DO require the host (an attachment must be stored on the
  // box; audio is real-time and can't be queued), so they gate on the host.
  const linkDown = conn !== 'connected';
  const disabled = hostControlsDisabled(conn, daemon); // attach + voice
  const disabledReason = hostControlDisabledReason(conn, daemon);
  const linkReason = linkDown ? hostControlDisabledReason(conn, daemon) : null;

  const running = row?.activity === 'running';
  React.useEffect(() => {
    if (running) {
      clearPendingSendTimeout();
      setPendingSend(false);
    }
  }, [running]);
  const permissionMode = row?.permissionMode;
  const chatModel = row?.model ?? null;

  // Model pill (spec/15 § Composer — Model pill; parity with web's header
  // crumb, spec/14 § Model selector). A pick sends `chat.model_request` on the
  // socket; the host's answer is the `chat.state` that lands on `row.model`.
  // Until it lands the pill reads the pending pick, dimmed; if it never lands
  // the pill goes back and says so (NO FALLBACK).
  const [pendingModel, setPendingModel] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (pendingModel !== null && chatModel === pendingModel) setPendingModel(null);
  }, [pendingModel, chatModel]);
  React.useEffect(() => {
    if (pendingModel === null) return;
    const t = setTimeout(() => {
      setPendingModel(null);
      useUiStore
        .getState()
        .pushError(
          `the machine did not switch the model — this chat is still on ${chatModel ?? 'its previous model'}`,
        );
    }, MODEL_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [pendingModel, chatModel]);
  // spec/04 § History — a cross-provider switch may cost more (no cache to
  // resume from), so the picker confirms it first unless the account has
  // turned that off (Settings has a toggle to bring it back).
  const [providerSwitchTarget, setProviderSwitchTarget] = React.useState<string | null>(null);

  const sendModelChange = (modelId: string): void => {
    setPendingModel(modelId);
    getWs().send({ type: 'chat.model_request', chatId, model: modelId });
  };

  const chooseModel = (modelId: string): void => {
    if (modelId === (pendingModel ?? chatModel)) return;
    const crossProvider =
      chatModel !== null && harnessForModel(modelId) !== harnessForModel(chatModel);
    if (crossProvider && !suppressProviderSwitchWarningOrFalse()) {
      setProviderSwitchTarget(modelId);
      return;
    }
    sendModelChange(modelId);
  };

  // Effort (spec/04 § Effort; parity with web's effort pill, spec/14 §
  // Composer — Effort control). Claude backend only. Same pending rule as the
  // model pill: the pick reads dimmed until the host's `chat.state` carries
  // it, and goes back with an error if it never does (NO FALLBACK).
  const showEffort = chatModel !== null && harnessForModel(chatModel) === 'claude';
  const [pendingEffort, setPendingEffort] = React.useState<{ value: EffortLevel | null } | null>(
    null,
  );
  const chatEffort = row?.effort ?? null;
  React.useEffect(() => {
    if (pendingEffort !== null && chatEffort === pendingEffort.value) setPendingEffort(null);
  }, [pendingEffort, chatEffort]);
  React.useEffect(() => {
    if (pendingEffort === null) return;
    const t = setTimeout(() => {
      setPendingEffort(null);
      useUiStore
        .getState()
        .pushError(
          'the machine did not switch the effort level — this chat is still on the value it had',
        );
    }, MODEL_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [pendingEffort]);
  const effortShown = pendingEffort !== null ? pendingEffort.value : chatEffort;
  const [effortMenuOpen, setEffortMenuOpen] = React.useState(false);
  const [addMenuOpen, setAddMenuOpen] = React.useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = React.useState(false);
  const effortItems = [
    {
      id: 'default',
      label: 'Let the model decide',
      testID: 'effort-option-default',
      selected: effortShown === null,
    },
    ...EFFORT_LEVELS.map((l) => ({
      id: l,
      label: EFFORT_LABELS[l],
      testID: `effort-option-${l}`,
      selected: effortShown === l,
    })),
  ];
  const onEffortSelect = (id: string): void => {
    setEffortMenuOpen(false);
    const effort = id === 'default' ? null : (id as EffortLevel);
    if (effort === effortShown) return;
    setPendingEffort({ value: effort });
    getWs().send({ type: 'chat.effort_request', chatId, effort });
  };

  // Padlock (spec/15 § Composer — Permission mode padlock): the mode list,
  // friendly names, modes the model cannot run greyed but still listed so the
  // user can see why they are not on offer. The mode in force is ticked.
  const [modeMenuOpen, setModeMenuOpen] = React.useState(false);
  const offeredModes = offeredPermissionModes(chatModel);
  const modeItems = PERMISSION_MODE_ORDER.map((m) => ({
    id: m,
    label: permissionModeLabel(m),
    testID: `permission-mode-option-${m}`,
    disabled: !offeredModes.includes(m),
    selected: m === permissionMode,
    destructive: m === 'bypassPermissions',
  }));
  const onModeSelect = (id: string): void => {
    if (id === permissionMode) return;
    getWs().send({ type: 'chat.settings', chatId, permissionMode: id as PermissionMode });
  };
  const ModeIcon = permissionModeIcon(permissionMode ?? 'default');
  const bypass = permissionMode === 'bypassPermissions';

  // Stop (parity with web's stop button + Claude Code's interrupt): the host
  // closes the in-flight query and settles the chat to idle; anything queued
  // then drains as normal.
  const stopTurn = (): void => {
    clearPendingSendTimeout();
    setPendingSend(false);
    getWs().send({ type: 'chat.stop_request', chatId });
  };

  const inputRef = React.useRef<TextInput>(null);
  // A completion/backspace-chip-removal computes the new cursor position
  // itself, but can only apply it once the input actually holds the new text
  // — set here and consumed once `draft` next changes (see the effect below).
  const pendingCursorRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const pos = pendingCursorRef.current;
    if (pos === null) return;
    pendingCursorRef.current = null;
    // `setNativeProps` isn't implemented on the fake host instance the unit
    // tests render against — only imperative, so its absence is otherwise
    // harmless there (no real cursor to move).
    inputRef.current?.setNativeProps?.({ selection: { start: pos, end: pos } });
    setCursorState({ text: body, pos });
    selectionEndRef.current = pos;
  }, [body]);

  // Dictation (spec/07 § "Dictation into the composer"): the mic streams live
  // to the composer — the interim transcript renders inside the input
  // while recording (`livePartial` below), then lands in `draft`, editable, on
  // gesture-end. NO overlay screen — the input itself is the feedback, and
  // nothing here touches voiceStore (that store backs the OTHER voice-note
  // triggers, which DO auto-send + overlay). See `lib/dictation.ts` for the
  // capture/transport design and, critically, how it avoids the race that
  // sank the earlier streaming attempt.
  const [micState, setMicState] = React.useState<'idle' | 'recording' | 'transcribing'>('idle');
  // The live/interim transcript, shown inside the input while recording. Cleared the instant a dictation ends (commit or cancel) — the
  // committed text takes over `draft` instead.
  const [livePartial, setLivePartial] = React.useState('');
  // How far the input has scrolled, so the chip mirror drawn over it scrolls
  // with it — otherwise a message past the height cap shows its top forever.
  const [inputScrollY, setInputScrollY] = React.useState(0);
  // Rendered height of the dictation mirror, so the input can grow to fit it.
  const [mirrorHeight, setMirrorHeight] = React.useState(0);
  // Mic recording, or dictation mode with words being spoken: the input is painted over by the mirror.
  const livePreviewOn = micState !== 'idle' || livePartial !== '';
  // The keyboard is away while dictating, so the field may take far more of
  // the screen than its typing cap before the words start scrolling.
  const { height: windowHeight } = useWindowDimensions();
  const inputMaxHeight = livePreviewOn ? dictationMaxHeight(windowHeight) : COMPOSER_MAX_HEIGHT;
  // spec/15 § Skill autocomplete — chips: the mirror only needs to exist
  // while there's a chip to draw, and only when dictation isn't already using
  // the transparent-input trick for its own mirror — the two never overlap.
  const showChipMirror = !livePreviewOn && chipTokens.length > 0;
  // Send pressed while dictating: the dictation ends and, once its transcript
  // lands in the draft, the whole draft goes out as one message.
  const sendAfterDictationRef = React.useRef(false);
  const dictationRef = React.useRef<DictationHandle | null>(null);
  // Set the instant Clear is pressed so a partial/result already in flight (an
  // onPartial call, or `finish()` resolving) is dropped instead of reviving
  // the just-discarded dictation.
  const discardedRef = React.useRef(false);
  // Bumped when a dictation begins and when one is cleared, so a commit still
  // in flight can tell it belongs to a session that is no longer the current
  // one — `discardedRef` alone is reset by the NEXT dictation.
  const dictationEpochRef = React.useRef(0);
  // Resolve mic permission + the recording audio mode BEFORE the user ever
  // presses, so `startDictation` has nothing to await before the microphone
  // opens (lib/dictation.ts § TIMING). Rejections are not surfaced from here:
  // this is speculative work on a screen the user may never dictate from, and
  // the authoritative permission failure is reported by the press path.
  React.useEffect(() => {
    void warmDictation().catch(() => undefined);
  }, []);

  // Leaving the chat mid-dictation must release the microphone: a session
  // whose gesture never ends would otherwise hold it open for the app's life.
  React.useEffect(
    () => () => {
      const handle = dictationRef.current;
      dictationRef.current = null;
      if (handle) void handle.finish(false);
    },
    [],
  );

  function beginDictation(): void {
    // spec/07 § Dictation engines: the engine is an account setting. It is
    // loaded at launch; a press that beats it waits for it.
    const settings = useSettingsStore.getState().data;
    if (settings === null) {
      void useSettingsStore
        .getState()
        .load()
        .then(() => {
          if (useSettingsStore.getState().data === null) {
            const why = useSettingsStore.getState().error ?? 'unknown error';
            useUiStore.getState().pushError(`voice: could not load settings: ${why}`);
            return;
          }
          beginDictation();
        });
      return;
    }
    const { engine, tidy } = dictationEngineFor(settings.preferences.voiceConfig.dictation);
    // Dictation on a backend this chat's host has no key for is refused at the
    // press, not after the user has spoken (the host refuses it too). The
    // phone's recogniser needs no key.
    const refusal = engine === 'phone' ? null : voiceKeyRefusal(chatId, 'dictation');
    if (refusal !== null) {
      useUiStore.getState().pushError(`voice: ${refusal}`);
      return;
    }
    discardedRef.current = false;
    dictationEpochRef.current += 1;
    // Dictating is talking, not typing: put the keyboard away so the listening
    // strip and the live words have the room (spec/07 § Dictation into the
    // composer). The input is not locked — tapping it brings the keyboard back.
    Keyboard.dismiss();
    inputRef.current?.blur();
    setLivePartial('');
    setMicState('recording');
    const factory = dictationFactory ?? startDictation;
    dictationRef.current = factory(
      dictationChatId ?? chatId,
      (text: string): void => {
        if (discardedRef.current) return;
        setLivePartial(text);
      },
      (message: string): void => {
        if (discardedRef.current) return;
        dictationRef.current = null;
        setMicState('idle');
        setLivePartial('');
        useUiStore.getState().pushError(`voice: ${message}`);
      },
      (message: string): void => {
        // Preview or tidy-up only: the recording carries on and the words still land.
        if (discardedRef.current) return;
        useUiStore
          .getState()
          .pushError(
            engine === 'whisper'
              ? `voice: live preview unavailable — ${message}`
              : `voice: ${message}`,
          );
      },
      { engine, tidy },
    );
  }

  async function commitDictation(): Promise<void> {
    const handle = dictationRef.current;
    dictationRef.current = null;
    if (!handle) {
      setMicState('idle');
      setLivePartial('');
      return;
    }
    setMicState('transcribing');
    const epoch = dictationEpochRef.current;
    const superseded = (): boolean => discardedRef.current || epoch !== dictationEpochRef.current;
    try {
      const outcome = await handle.finish(true);
      // Clear was pressed while the upload was in flight (and maybe a new
      // dictation begun since): this result belongs to nobody now.
      if (superseded()) return;
      // Every no-text outcome names its own cause. NO FALLBACK: none of them
      // is allowed to be a silent no-op, because a dictation that appears to
      // do nothing is indistinguishable from a broken microphone.
      switch (outcome.kind) {
        case 'text': {
          // Append into the composer's own draft, editable before send —
          // never auto-sent (spec/07 § "Dictation into the composer").
          // The keyboard stays down: the words are ready to send as they
          // are, and a tap on the input brings it back to edit them.
          const t = outcome.text;
          updateDraft((cur) => (cur.trim().length > 0 ? `${cur.trimEnd()} ${t}` : t));
          break;
        }
        case 'no-audio':
          useUiStore.getState().pushError('voice: nothing recorded — the mic never started');
          break;
        case 'too-short':
          useUiStore
            .getState()
            .pushError(`voice: too short to transcribe (${(outcome.ms / 1000).toFixed(1)}s)`);
          break;
        case 'no-speech':
          useUiStore.getState().pushError('voice: no speech recognised');
          break;
        // Only reachable if the session had already been finished elsewhere:
        // nothing to land and nothing to report.
        case 'discarded':
          break;
      }
      if (sendAfterDictationRef.current) {
        sendAfterDictationRef.current = false;
        // Whatever is in the box now — typed text plus anything just heard.
        // A no-text outcome has already said why above.
        submitRef.current();
      }
    } catch (e) {
      // A dictation that was cleared (or replaced) failing late is no one's
      // business now — and must not reset the NEXT dictation's send-after flag.
      if (superseded()) return;
      sendAfterDictationRef.current = false;
      useUiStore.getState().pushError(`voice transcription failed: ${(e as Error).message}`);
    } finally {
      if (!superseded()) {
        setMicState('idle');
        setLivePartial('');
      }
    }
  }

  // Dictation mode (spec/07 § Dictation mode): long-press the mic → Keep
  // dictating, and it stays open — each time the speaker finishes what they
  // said is sent as its own message and it keeps listening. Tapping the mic or the
  // clear control ends it. Not a call: nothing speaks back.
  const [dictModeOn, setDictModeOn] = React.useState(false);
  const [dictPending, setDictPending] = React.useState(0);
  const dictModeRef = React.useRef<DictationModeHandle | null>(null);
  function stopDictationMode(): void {
    const h = dictModeRef.current;
    dictModeRef.current = null;
    setLivePartial('');
    setDictModeOn(false);
    setDictPending(0);
    if (h) void h.stop();
  }
  // Long-press the mic: the ways to dictate beyond a plain tap.
  const [micMenuOpen, setMicMenuOpen] = React.useState(false);
  function startDictMode(): void {
    // The pause is a shared setting; the store is normally loaded at launch.
    if (useSettingsStore.getState().data === null) {
      void useSettingsStore
        .getState()
        .load()
        .then(() => {
          if (useSettingsStore.getState().data === null) {
            const why = useSettingsStore.getState().error ?? 'unknown error';
            useUiStore.getState().pushError(`voice: could not load settings: ${why}`);
            return;
          }
          startDictMode();
        });
      return;
    }
    const refusal = voiceKeyRefusal(chatId, 'dictation');
    if (refusal !== null) {
      useUiStore.getState().pushError(`voice: ${refusal}`);
      return;
    }
    const prefs = useSettingsStore.getState().data!.preferences;
    Keyboard.dismiss();
    inputRef.current?.blur();
    setDictModeOn(true);
    const factory = dictationModeFactory ?? startDictationMode;
    dictModeRef.current = factory(
      {
        onText: (t: string): void => {
          const cur = draftRef.current;
          updateDraft(cur.trim().length > 0 ? `${cur.trimEnd()} ${t}` : t);
          submitRef.current();
        },
        onBusy: (n: number): void => setDictPending(n),
        onPartial: (t: string): void => setLivePartial(t),
        onError: (message: string): void => {
          useUiStore.getState().pushError(`voice: ${message}`);
        },
      },
      {
        chatId: dictationChatId ?? chatId,
        segmenter: { silenceMs: prefs.dictationPauseSeconds * 1000 },
        turnDetection: prefs.dictationTurnDetection,
      },
    );
  }
  React.useEffect(() => stopDictationMode, [chatId]);

  /** Discard the in-flight dictation (Clear button) — never lands any text. */
  function cancelDictation(): void {
    sendAfterDictationRef.current = false;
    discardedRef.current = true;
    dictationEpochRef.current += 1;
    const handle = dictationRef.current;
    dictationRef.current = null;
    setMicState('idle');
    setLivePartial('');
    if (handle) void handle.finish(false);
  }

  const addAttachments = (
    files: Array<{ uri: string; name: string; mimeType: string; width?: number; height?: number }>,
  ): void => {
    useComposerAttachmentStore.getState().attach(chatId, attachmentTarget, files);
  };
  const removeAttachment = (key: string): void => {
    useComposerAttachmentStore.getState().remove(chatId, attachmentTarget, key);
  };
  // The image being marked up (spec/15 § Composer — attachments). Done swaps
  // the annotated PNG in for it, in the same place in the chip row.
  const [annotating, setAnnotating] = React.useState<PendingAttachment | null>(null);
  const finishAnnotation = (next: AnnotatedImage): void => {
    const original = annotating;
    setAnnotating(null);
    if (original === null) return;
    try {
      useComposerAttachmentStore.getState().replace(chatId, attachmentTarget, original.key, next);
    } catch (e) {
      useUiStore.getState().pushError(`annotate failed: ${(e as Error).message}`);
    }
  };

  // Pen button → a blank page to draw on, no photo needed; Done attaches the
  // drawing as a new image chip.
  const [sketching, setSketching] = React.useState(false);
  const finishSketch = (next: AnnotatedImage): void => {
    setSketching(false);
    addAttachments([next]);
  };

  // Image button → photo library. NO FALLBACK: a denied permission surfaces an
  // error rather than silently doing nothing.
  const pickImage = async (): Promise<void> => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) throw new Error('photo library permission denied');
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        // Multi-select (spec/15 § Composer): a phone pick is a whole trip
        // through the OS picker, so one trip must be able to bring back every
        // image the user wants — never one-per-tap.
        allowsMultipleSelection: true,
      });
      if (res.canceled) return;
      addAttachments(
        res.assets.map((asset) => ({
          uri: asset.uri,
          name: asset.fileName ?? `image-${Date.now()}.jpg`,
          mimeType: asset.mimeType ?? 'image/jpeg',
          width: asset.width,
          height: asset.height,
        })),
      );
    } catch (e) {
      useUiStore.getState().pushError(`attach image failed: ${(e as Error).message}`);
    }
  };

  // Camera button → take a photo NOW (spec/15 § Composer). One tap, not a
  // hidden long-press: on a phone the thing you want to send often doesn't
  // exist yet. The capture is an ordinary image attachment from here on — same
  // chip, same downscale, same upload. NO FALLBACK: a denied camera permission
  // surfaces an error rather than silently doing nothing.
  const takePhoto = async (): Promise<void> => {
    try {
      if (!(await ensurePermission('camera'))) throw new Error('camera permission denied');
      const res = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
      });
      if (res.canceled) return;
      addAttachments(
        res.assets.map((asset) => ({
          uri: asset.uri,
          name: asset.fileName ?? `photo-${Date.now()}.jpg`,
          mimeType: asset.mimeType ?? 'image/jpeg',
          width: asset.width,
          height: asset.height,
        })),
      );
    } catch (e) {
      useUiStore.getState().pushError(`take photo failed: ${(e as Error).message}`);
    }
  };

  // A long text paste is saved to a cache file and attached like a picked file.
  // NO FALLBACK: a failed write surfaces an error and the pasted text is lost
  // from the input only because the write was refused — never silently.
  const attachPastedText = async (inserted: string): Promise<void> => {
    try {
      const uri = `${FileSystem.cacheDirectory}pasted-text-${Date.now()}.md`;
      await FileSystem.writeAsStringAsync(uri, inserted, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      addAttachments([{ uri, name: pastedTextName(inserted), mimeType: 'text/markdown' }]);
    } catch (e) {
      useUiStore.getState().pushError(`attach pasted text failed: ${(e as Error).message}`);
    }
  };

  // Paperclip button → OS file picker (any type).
  const pickDocument = async (): Promise<void> => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        // ANY type, stated explicitly (spec/15 § Composer — "Attaching is never
        // limited to photos"), and multi-select for the same reason as the
        // image picker. `copyToCacheDirectory` gives the upload a readable
        // local file even when the pick came from a cloud provider (Drive).
        type: '*/*',
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      addAttachments(
        res.assets.map((asset) => ({
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType ?? 'application/octet-stream',
        })),
      );
    } catch (e) {
      useUiStore.getState().pushError(`attach file failed: ${(e as Error).message}`);
    }
  };

  // Image paste (spec/15 § Composer — "Paste"): long-press → Paste of an image,
  // or a keyboard's image insertion, lands here through the PatchPaste native
  // listener on the input and is attached like a picked image. Text paste
  // never reaches this — the input pastes it as plain text itself.
  React.useEffect(
    () =>
      receiveImagePaste(inputRef.current, {
        onImages: (files) => addAttachments(files),
        onError: (message) => useUiStore.getState().pushError(message),
      }),
    // addAttachments closes over chatId/attachmentTarget only.
    [chatId, isNewChatDraft],
  );

  // Build the outgoing-message shape for one already-known attachment —
  // carries its `ref` when uploaded (step 3 of 3: sendQueue then uses it
  // as-is, never re-uploading), or `refPromise` (a caller-built wait) for
  // one Send raced ahead of. Anything else (a `failed` chip, or one that
  // never made it to the draft store — e.g. attached offline) carries bare
  // `uri`, which sendQueue falls back to uploading itself.
  const toOutgoingFile = (
    a: PendingAttachment,
    refPromise?: Promise<AttachmentRef>,
  ): OutgoingFile => ({
    ...(a.uri ? { uri: a.uri } : {}),
    ...(a.url ? { url: a.url } : {}),
    name: a.name,
    mimeType: a.mimeType,
    kind: a.kind,
    width: a.width,
    height: a.height,
    ...(a.status === 'uploaded'
      ? { ref: { id: a.key, name: a.name, mimeType: a.mimeType, kind: a.kind } }
      : refPromise
        ? { refPromise }
        : {}),
  });

  // Wait for `a`'s attach-time upload (already in flight, on THIS chat's
  // composer draft) to settle — existing chat only; a new-chat draft needs
  // its own promote-after-wait (see `sendDraft`'s `sendTarget` branch).
  const waitForOwnUpload = (a: PendingAttachment): Promise<AttachmentRef> => {
    const p = waitForAttachmentUpload(chatId, a.key).then((settled) => {
      if (settled?.status === 'uploaded') {
        return {
          id: settled.key,
          name: settled.name,
          mimeType: settled.mimeType,
          kind: settled.kind,
        };
      }
      throw new Error(`attachment upload failed: ${a.name}`);
    });
    p.catch(() => {}); // a caller that never awaits this must not see an unhandled rejection
    return p;
  };

  // Echo + send (spec/15 § Composer → Attachments): the message is in the
  // stream at once — attachments from their local copies, uploading — and the
  // composer clears. lib/sendQueue.ts uploads and delivers it, in send order.
  // The send can finish well after Send was pressed (a hook check, creating a
  // new chat), and the box stays editable meanwhile, so it clears only the
  // draft that was sent, and only if it is still the one that was sent.
  // Anything typed since is the user's next message.
  const sendNow = (
    target: string,
    text: string,
    files: OutgoingFile[],
    pending: PendingAttachment[],
    hookResults: HookRunResult[] = [],
    draftAtSend?: string,
  ): void => {
    const localId = sendMessage(target, text, files);
    // First message is when a reply you might not be watching for becomes
    // possible: explain + ask for notifications now (once per session).
    void enablePushNotifications().catch((e: Error) =>
      useUiStore.getState().pushError(`push registration failed: ${e.message}`),
    );
    const notes = adviseNotes(hookResults);
    if (notes.length > 0) {
      useChatStore.getState().patchLocalMessage(target, localId, { hookAdvise: notes });
    }
    if (pending.length > 0) {
      // Bookkeeping-only: the ids just sent now belong to the message, not
      // the draft. NEVER deletes a byte. A file attached since stays.
      // A file still uploading is released by the store once its upload lands.
      const removed = useComposerAttachmentStore.getState().detach(
        chatId,
        pending.map((a) => a.key),
      );
      // A new-chat draft is discarded wholesale by the caller once it spawns
      // — only an existing chat's composer draft needs the server told.
      // Read after the detach: a file that landed since Send is uploaded by now.
      const ready = removed.filter((a) => a.status === 'uploaded').map((a) => a.key);
      if (sendTarget === undefined && ready.length > 0) {
        api.detachAttachments(target, ready).catch((err: Error) => {
          useUiStore
            .getState()
            .pushError(`couldn’t release the draft’s attachments: ${err.message}`);
        });
      }
    }
    const now = draftRef.current;
    if (draftAtSend === undefined || now === draftAtSend) updateDraft('');
    // Typed on after what was sent: the sent part goes, the rest stays. Edited
    // somewhere inside it, there is no telling what is left, so it all stays.
    else if (now.startsWith(draftAtSend)) updateDraft(now.slice(draftAtSend.length).trimStart());
  };

  const submit = (): void => {
    // Send while dictating ends the dictation and sends it with anything
    // typed; mid-transcription it waits for the words to land.
    if (micState !== 'idle') {
      sendAfterDictationRef.current = true;
      if (micState === 'recording') void commitDictation();
      return;
    }
    sendDraft();
  };

  const sendDraft = (): void => {
    if (resolving) return;
    if (edit) {
      edit.onSave(draftRef.current.trim());
      return;
    }
    // No `linkDown` guard: sending into an existing chat while the link is
    // down queues + flushes on reconnect (Todoist 6hWrcpCQFqXGJpF6; spec/12 §
    // Surface → server disconnect — deliveryTracker already retries
    // regardless of why a send failed).
    // The ref, not state: a dictated send lands its words in the same tick.
    const draftAtSend = draftRef.current;
    const text = draftAtSend.trim();
    if (!text && attachments.length === 0) return;
    const pending = attachments;

    // New chat (spec/15 § New chat flow): the chat is created by this first
    // send. Opens at once either way (spec/14 § New chat) — an attachment
    // still uploading to the draft is not waited for here; its OWN
    // `refPromise` (wait, then promote just it) covers that, exactly as an
    // existing chat's does.
    if (sendTarget !== undefined) {
      setResolving(true);
      void (async () => {
        let target: string | null = null;
        try {
          target = await sendTarget();
        } catch (e) {
          useUiStore.getState().pushError(`failed to create chat: ${(e as Error).message}`);
        } finally {
          setResolving(false);
        }
        if (target === null) return;
        const draftId = chatId;
        let promotedById = new Map<string, AttachmentRef>();
        try {
          const { refs } = await api.promoteNewChatDraftAttachments(draftId, target);
          promotedById = new Map(refs.map((r) => [r.id, r]));
        } catch (e) {
          useUiStore.getState().pushError(`attachment upload failed: ${(e as Error).message}`);
        }
        const files = pending.map((a) => {
          const promoted = promotedById.get(a.key);
          if (promoted) return { ...toOutgoingFile(a), ref: promoted };
          if (a.status === 'uploading') {
            // Wait for the draft-scoped upload, then promote JUST this one
            // — by the time it resolves, the draft holds only it (the loop
            // above already moved everything that was ready then).
            const refPromise = waitForAttachmentUpload(draftId, a.key).then(async (settled) => {
              if (settled?.status !== 'uploaded') {
                throw new Error(`attachment upload failed: ${a.name}`);
              }
              const { refs } = await api.promoteNewChatDraftAttachments(draftId, target);
              const match = refs.find((r) => r.id === settled.key);
              if (!match) throw new Error(`attachment upload failed: ${a.name}`);
              return match;
            });
            refPromise.catch(() => {});
            return toOutgoingFile(a, refPromise);
          }
          return toOutgoingFile(a);
        });
        sendNow(target, text, files, pending, [], draftAtSend);
        onSent?.(target);
      })();
      return;
    }

    // Hold the busy styling until the host confirms the turn as running —
    // bounded, so a send that never gets that back (e.g. queued while
    // offline) still settles rather than spinning forever. Only for a plain
    // send: one with an attachment already gets its own "did this land"
    // feedback from the message's `Uploading` status in the stream.
    if (hookChecking) return;
    const command = runSlashCommand(text, {
      chatId,
      hostId: row?.hostId ?? null,
      goal: row?.goal ?? null,
      reminder: row?.reminder ?? null,
      setGoal: (g) => useChatStore.getState().setGoal(chatId, g),
      setReminder: (r) => useChatStore.getState().setReminder(chatId, r),
      clearTimeline: () => useChatStore.getState().clearTimeline(chatId),
      chooseModel,
      pushError: (m) => useUiStore.getState().pushError(m),
      api,
    });
    if (command.handled) {
      updateDraft('');
      return;
    }
    if (command.text !== text) {
      // `/goal <text>` sets the goal and sends the text as the turn.
      sendCheckedText(command.text, pending, draftAtSend);
      return;
    }
    sendCheckedText(text, pending, draftAtSend);
  };

  // Hook check, then delivery (spec/20-hooks.md).
  const sendCheckedText = (
    text: string,
    pending: PendingAttachment[],
    draftAtSend: string,
  ): void => {
    setHookChecking(true);
    void (async () => {
      const check = await checkHooks(chatId, text, pending);
      setHookChecking(false);
      if (check.decision === 'block') {
        setHookBlock({ text, pending, results: check.results, draftAtSend });
        return;
      }
      deliver(text, pending, check.results, draftAtSend);
    })();
  };

  // The send proper, past the hook check.
  const deliver = (
    text: string,
    pending: PendingAttachment[],
    hookResults: HookRunResult[],
    draftAtSend: string,
  ) => {
    if (!running && pending.length === 0) {
      clearPendingSendTimeout();
      setPendingSend(true);
      pendingSendTimeoutRef.current = setTimeout(
        () => setPendingSend(false),
        PENDING_SEND_TIMEOUT_MS,
      );
    }
    const files = pending.map((a) =>
      toOutgoingFile(a, a.status === 'uploading' ? waitForOwnUpload(a) : undefined),
    );
    sendNow(chatId, text, files, pending, hookResults, draftAtSend);
  };

  // Send stays enabled whether it's the host or the LINK itself that's
  // down — either way the message queues and delivers on reconnect (spec/12
  // § Host-offline UX + Surface → server disconnect; Todoist
  // 6hWrcpCQFqXGJpF6). Attach/voice gate on the host (`disabled`) and, via
  // `linkReason`, on the link too — they have nothing to queue into.
  // The dictation commit submits after an await; it must use this render's
  // attachments and chat state, not the ones from when it began.
  const submitRef = React.useRef(sendDraft);
  submitRef.current = sendDraft;

  const sendDisabled =
    !edit &&
    (resolving ||
      hookChecking ||
      (draft.trim().length === 0 && attachments.length === 0 && micState === 'idle'));

  // Un-pressable and DEAD are different things. A send held open while the
  // new chat is created — or by `pendingSend` waiting on the host to confirm
  // the turn — keeps the active leaf colour and swaps its arrow for a
  // spinner, so the tap visibly did something; only a genuinely unavailable
  // send greys out.
  const sendBusy = resolving || pendingSend || hookChecking;
  const sendLooksInactive = sendDisabled && !sendBusy;

  // Stop REPLACES Send while a turn runs and there is nothing to send. The
  // moment there is text or an attachment, Send is back — and a send now is
  // queued by the host behind the running turn (spec/04 ## Message queueing),
  // the same thing a web send mid-turn does. A chat being created keeps its
  // spinner on Send: that send is already under way.
  // A send still waiting on the host's `running` (`pendingSend`) offers Stop
  // too — otherwise there is no way to cancel it while it is in flight.
  // A chat parked only on the agent's own question is waiting for the user, not
  // working: nothing to stop.
  const pendingTools = row?.pendingPermissions ?? [];
  const onlyQuestionsPending =
    pendingTools.length > 0 && pendingTools.every((p) => p.tool === 'AskUserQuestion');
  const showStop =
    !edit &&
    (running ||
      (row?.activity === 'awaiting-permission' && !onlyQuestionsPending) ||
      pendingSend) &&
    !resolving &&
    draft.trim().length === 0 &&
    attachments.length === 0 &&
    micState === 'idle';

  return (
    <View
      style={{
        padding: space.md,
        gap: space.xs,
        backgroundColor: colors.paperRaised,
        borderTopWidth: 1,
        borderColor: colors.lineSoft,
      }}
    >
      {hookBlock ? (
        <HookBlockSheet
          results={hookBlock.results}
          onUseSuggestion={(suggestion) => {
            updateDraft(suggestion);
            setHookBlock(null);
          }}
          onEdit={() => setHookBlock(null)}
          onSendAnyway={() => {
            const b = hookBlock;
            setHookBlock(null);
            deliver(b.text, b.pending, b.results, b.draftAtSend);
          }}
        />
      ) : null}
      {/* Quote cards stacked above the input (spec/15 § Composer — quotes). */}
      {quotes.length > 0 ? (
        <View testID="composer-quotes" style={{ gap: space.xs, paddingBottom: space.xs }}>
          {quotes.map((q, i) => (
            <View
              key={i}
              testID="composer-quote"
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: space.xs,
                paddingVertical: space.xs,
                paddingLeft: space.sm,
                paddingRight: space.xs,
                borderLeftWidth: 3,
                borderLeftColor: colors.ink2,
                borderRadius: radii.sm,
                backgroundColor: colors.paper,
              }}
            >
              <Text style={{ flex: 1, color: colors.ink2 }} numberOfLines={3}>
                {q}
              </Text>
              <Pressable
                testID="composer-quote-remove"
                accessibilityLabel="remove quote"
                hitSlop={8}
                onPress={() =>
                  updateDraft(
                    joinQuotes(
                      quotes.filter((_, j) => j !== i),
                      body,
                    ),
                  )
                }
              >
                <X size={16} color={colors.ink2} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {/* Removable thumbnails/chips above the input (spec/15 § Composer). */}
      {attachments.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.xs, paddingBottom: space.xs }}
          style={{ opacity: resolving ? 0.6 : 1 }}
        >
          {attachments.map((a) => (
            <View
              key={a.key}
              testID="composer-attachment"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.xs,
                paddingHorizontal: space.xs,
                paddingVertical: 4,
                borderRadius: radii.sm,
                borderWidth: 1,
                borderColor: a.status === 'failed' ? colors.red : colors.divider,
                backgroundColor: colors.paper,
                maxWidth: 220,
              }}
            >
              {a.kind === 'image' && (a.uri ?? a.url) ? (
                <Image
                  source={{ uri: a.uri ?? a.url }}
                  style={{ width: 36, height: 36, borderRadius: 4 }}
                />
              ) : (
                <FileText size={18} color={colors.ink2} />
              )}
              <Text
                numberOfLines={1}
                style={{ color: colors.ink2, fontSize: textMin, flexShrink: 1 }}
              >
                {a.name}
              </Text>
              {a.status === 'failed' ? (
                <>
                  <Text style={{ color: colors.red, fontSize: textMin }}>Not uploaded</Text>
                  <Pressable
                    testID="composer-attachment-retry"
                    onPress={() =>
                      useComposerAttachmentStore.getState().retry(chatId, attachmentTarget, a.key)
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`Retry ${a.name}`}
                    hitSlop={8}
                  >
                    <Text style={{ color: colors.leaf, fontSize: textMin }}>Retry</Text>
                  </Pressable>
                </>
              ) : null}
              {a.kind === 'image' ? (
                <Pressable
                  onPress={() => setAnnotating(a)}
                  disabled={resolving}
                  accessibilityRole="button"
                  accessibilityLabel={`Annotate ${a.name}`}
                  hitSlop={8}
                >
                  <Pencil size={16} color={colors.ink3} />
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => removeAttachment(a.key)}
                disabled={resolving}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${a.name}`}
                hitSlop={8}
              >
                <X size={16} color={colors.ink3} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <ImageAnnotatorModal
        attachment={annotating}
        onDone={finishAnnotation}
        onCancel={() => setAnnotating(null)}
      />
      <ImageAnnotatorModal
        attachment={null}
        sketch={sketching}
        onDone={finishSketch}
        onCancel={() => setSketching(false)}
      />

      {/* Skill autocomplete list (spec/15 § Composer). Tap a row to complete. */}
      {showSkillMenu ? (
        <View
          testID="skill-menu"
          style={{
            marginBottom: space.xs,
            borderWidth: 1,
            borderColor: colors.divider,
            borderRadius: radii.md,
            backgroundColor: colors.paper,
            overflow: 'hidden',
            maxHeight: 200,
          }}
        >
          <ScrollView keyboardShouldPersistTaps="handled">
            {filteredSkills.map((s) => {
              const blocked = skills.includes(s) && providerCommands.has(s);
              return (
                <Pressable
                  key={s}
                  testID={`skill-option-${s}`}
                  accessibilityState={{ disabled: blocked }}
                  onPress={() => completeSkill(s)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.xs,
                    paddingHorizontal: space.md,
                    paddingVertical: space.sm,
                    backgroundColor: pressed && !blocked ? colors.divider : 'transparent',
                  })}
                >
                  <Text
                    style={{ ...typography.secondary, color: blocked ? colors.red : colors.leaf }}
                  >
                    /
                  </Text>
                  <Text
                    style={{ ...typography.secondary, color: blocked ? colors.red : colors.ink }}
                  >
                    {s}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {/* Listening strip (spec/15 § Composer): with the keyboard away, this is
          what says the mic is live — a pulsing dot, the state named, and how
          long it has been listening. */}
      {dictModeOn ? (
        <View
          testID="dictation-mode-status"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingHorizontal: space.xs,
          }}
        >
          <StatusDot
            color={dictPending > 0 ? colors.ink3 : colors.red}
            pulsing={dictPending === 0}
          />
          <Text style={{ ...typography.label, flex: 1, color: colors.ink }}>
            {dictPending > 0 ? 'Sending…' : 'Dictating'}
          </Text>
        </View>
      ) : null}

      {/* Two stacked rows (spec/15 § Composer): the text input owns the FULL
          width on its own row, and the action buttons sit on a second row
          beneath it. The input is the thing that runs out of room first — a
          five-button trio beside it left barely half the width for the text.
          `position: 'relative'` is explicit because the live-dictation mirror
          below is absolutely positioned against this box. */}
      <View testID="composer-input-row" style={{ position: 'relative' }}>
        <TextInput
          ref={inputRef}
          autoFocus={autoFocus || edit !== undefined}
          {...(edit ? { testID: 'queued-edit-input' } : {})}
          value={body}
          onChangeText={(text) => {
            // spec/15 § Composer — a long paste becomes a document attachment.
            const pasted = edit ? null : extractLongPaste(body, text);
            if (pasted !== null) {
              void attachPastedText(pasted.inserted);
              text = pasted.remaining;
            }
            updateDraft(joinQuotes(quotes, text));
            // Typing always lands the cursor at the end of what was just
            // typed — the same default a real browser textarea applies on a
            // programmatic value change. `onSelectionChange` (below) is the
            // authoritative source for anywhere the cursor moves WITHOUT
            // typing (arrow keys, tapping elsewhere) and overrides this.
            setCursorState({ text, pos: text.length });
            selectionEndRef.current = text.length;
          }}
          onSelectionChange={(e) => {
            setCursorState({ text: body, pos: e.nativeEvent.selection.start });
            selectionEndRef.current = e.nativeEvent.selection.end;
          }}
          onKeyPress={(e) => {
            // spec/15 § Skill autocomplete — Backspace right after a chip
            // removes the whole `/<skill> ` in one press. Only for a
            // collapsed cursor — a real selection deletes normally.
            if (e.nativeEvent.key !== 'Backspace') return;
            if (selectionEndRef.current !== cursorPos) return;
            const chip = chipEndingAt(body, cursorPos, knownChipNames);
            if (!chip) return;
            updateDraft(joinQuotes(quotes, body.slice(0, chip.start) + body.slice(cursorPos)));
            pendingCursorRef.current = chip.start;
          }}
          onFocus={() => {
            if (!edit) setDraftFocused(chatId, true);
          }}
          onBlur={() => {
            // spec/14 § Composer — a draft that arrived from another surface
            // while this composer had focus is held back rather than
            // overwriting text under the cursor; losing focus is what
            // resolves it, taking the newer text if there is one.
            if (edit) return;
            const applied = setDraftFocused(chatId, false);
            if (applied !== undefined) updateDraft(applied);
          }}
          // Typing stays possible while the link is down — only SENDING
          // gates on `linkDown` (Todoist 6hWrcpCQFqXGJpF6).
          editable={!resolving}
          multiline
          scrollEnabled
          onScroll={(e) => setInputScrollY(e.nativeEvent.contentOffset.y)}
          // While a dictation is running the input is painted over by the
          // mirror above, and the placeholder — drawn by the TextInput, in the
          // same box — renders THROUGH it on an empty draft, so the two
          // strings sit on top of each other (Todoist 6hVPGMcWfgcW6256:
          // "when voice note is recording, placeholder should disappear, its
          // writing on top"). Nothing about an empty input needs naming while
          // the user is talking into it.
          placeholder={
            livePreviewOn ? undefined : linkDown ? (linkReason ?? 'Disconnected…') : 'Message'
          }
          placeholderTextColor={colors.ink3}
          style={{
            // Grows upward with the content between these two bounds — the
            // list above is `flex: 1`, so the height the field takes is height
            // the transcript gives up and the composer's bottom edge stays put
            // (spec/15 § Composer). Past the cap it scrolls internally.
            // While dictating, the words are drawn by the mirror, not held by
            // the input, so grow to the mirror's height like typing would.
            minHeight: livePreviewOn
              ? Math.min(Math.max(COMPOSER_MIN_HEIGHT, mirrorHeight), inputMaxHeight)
              : COMPOSER_MIN_HEIGHT,
            maxHeight: inputMaxHeight,
            paddingLeft: edit ? space.md : FIELD_PAD_LEFT,
            paddingRight: FIELD_PAD_RIGHT,
            paddingVertical: space.sm,
            backgroundColor: colors.paper,
            borderWidth: 1,
            borderColor: colors.lineSoft,
            borderRadius: radii.lg,
            color: livePreviewOn || showChipMirror ? 'transparent' : colors.ink,
            fontSize: 16,
          }}
        />
        {/* Drawn AFTER the input: the input has an opaque `paper` background, so
            a mirror mounted before it is painted over and the live words are
            invisible (Todoist 6hj4XRHrpRCQp8Fc). */}
        {/* Live-dictation preview (Todoist 6hHGqGVpJqfcXPmm): a mirror of the
              input showing the committed draft in normal ink plus the
              in-progress transcript on a tint, sitting
              behind a text-transparent TextInput so the real input still owns
              the cursor/selection/editing throughout the recording (spec/07 §
              "Dictation into the composer" — "the input stays
              focusable/editable throughout"). Only mounted while there's
              something to preview, so idle typing is unaffected. */}
        {livePreviewOn ? (
          <View
            pointerEvents="none"
            onLayout={(e) => setMirrorHeight(e.nativeEvent.layout.height)}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              // Mirrors the input's own bounds exactly — a preview that clipped
              // at a different line from the field under it shows the user text
              // the field is still holding.
              minHeight: COMPOSER_MIN_HEIGHT,
              maxHeight: inputMaxHeight,
              overflow: 'hidden',
              // Past the cap the TOP is clipped, not the bottom: the newest
              // words are the ones being spoken, so they stay in view and the
              // live text never runs off the end of the box.
              justifyContent: 'flex-end',
            }}
          >
            <Text
              testID="dictation-preview"
              style={{
                paddingLeft: (edit ? space.md : FIELD_PAD_LEFT) + 1,
                paddingRight: FIELD_PAD_RIGHT + 1,
                paddingVertical: space.sm + 1,
                fontSize: 16,
              }}
            >
              <Text style={{ color: colors.ink }}>{body}</Text>
              {body.trim().length > 0 ? ' ' : ''}
              {/* Grey: in progress — rewritten as the user talks and replaced
                  outright by the committed transcript. */}
              <Text
                testID="dictation-live-words"
                style={{ color: colors.ink3, fontStyle: 'italic' }}
              >
                {livePartial}
              </Text>
            </Text>
          </View>
        ) : showChipMirror ? (
          // spec/15 § Skill autocomplete — chips: the same text-transparent-
          // TextInput trick as the dictation preview above, generalised: the
          // real input keeps the cursor and every editing gesture, and this
          // mirror draws the draft back over it with each completed
          // `/<skill>` boxed and tappable instead of plain.
          <View
            pointerEvents="box-none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              minHeight: COMPOSER_MIN_HEIGHT,
              maxHeight: COMPOSER_MAX_HEIGHT,
              overflow: 'hidden',
            }}
          >
            <Text
              testID="chip-mirror"
              style={{
                paddingLeft: (edit ? space.md : FIELD_PAD_LEFT) + 1,
                paddingRight: FIELD_PAD_RIGHT + 1,
                paddingVertical: space.sm + 1,
                fontSize: 16,
                color: colors.ink,
                transform: [{ translateY: -inputScrollY }],
              }}
            >
              {renderChipMirror()}
            </Text>
          </View>
        ) : null}
        {/* Drawn after both mirrors so it sits on top of them and stays
            tappable. */}
        <Pressable
          onPressIn={() => {
            if (disabled) return;
            // A press-in lands ~350ms before onLongPress, so this is a free
            // second chance to warm the audio plane if the mount-time attempt
            // ran before the permission existed.
            void warmDictation().catch(() => undefined);
          }}
          onPress={() => {
            if (disabled) return;
            if (dictModeOn) stopDictationMode();
            else if (micState !== 'idle') void commitDictation();
            else void beginDictation();
          }}
          onLongPress={() => {
            if (disabled) return;
            if (dictModeOn) stopDictationMode();
            else if (micState === 'idle') setMicMenuOpen(true);
          }}
          disabled={disabled || micState === 'transcribing'}
          delayLongPress={350}
          hitSlop={MIC_HIT_SLOP}
          pressRetentionOffset={MIC_PRESS_RETENTION}
          testID="composer-mic"
          style={({ pressed }) => ({
            position: 'absolute',
            right: FIELD_MIC_INSET,
            bottom: FIELD_MIC_INSET,
            width: FIELD_MIC_SIZE,
            height: FIELD_MIC_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: FIELD_MIC_SIZE / 2,
            backgroundColor: pressed ? colors.divider : 'transparent',
          })}
          accessibilityRole="button"
          accessibilityLabel={
            disabled
              ? `Dictate unavailable — ${disabledReason ?? 'disconnected'}`
              : micState === 'transcribing'
                ? 'Transcribing…'
                : 'Dictate into message'
          }
        >
          <ListeningRing active={micState === 'recording' || dictModeOn} color={colors.red} />
          <Mic
            size={FIELD_MIC_ICON_SIZE}
            color={
              disabled
                ? colors.inkFaint
                : micState === 'recording' || dictModeOn
                  ? colors.red
                  : colors.ink3
            }
          />
        </Pressable>
        {/* + (spec/15 § Composer): what goes INTO the message — camera, photo,
            any file, sketch — at the field's bottom-left, the mirror of the
            mic. While a dictation runs it becomes Cancel, the far end of the
            field from the mic, so stopping and cancelling are never one slip
            apart. */}
        {edit ? null : micState !== 'idle' || dictModeOn ? (
          <Pressable
            testID="dictation-cancel"
            onPress={dictModeOn ? stopDictationMode : cancelDictation}
            hitSlop={MIC_HIT_SLOP}
            style={({ pressed }) => ({
              position: 'absolute',
              left: FIELD_MIC_INSET,
              bottom: FIELD_MIC_INSET,
              width: FIELD_MIC_SIZE,
              height: FIELD_MIC_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: FIELD_MIC_SIZE / 2,
              backgroundColor: pressed ? colors.divider : 'transparent',
            })}
            accessibilityRole="button"
            accessibilityLabel={dictModeOn ? 'Stop dictation mode' : 'Clear dictation'}
          >
            <X size={FIELD_MIC_ICON_SIZE} color={colors.ink2} />
          </Pressable>
        ) : (
          <Pressable
            testID="composer-add"
            onPress={() => setAddMenuOpen(true)}
            disabled={disabled || resolving}
            hitSlop={MIC_HIT_SLOP}
            style={({ pressed }) => ({
              position: 'absolute',
              left: FIELD_MIC_INSET,
              bottom: FIELD_MIC_INSET,
              width: FIELD_MIC_SIZE,
              height: FIELD_MIC_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: FIELD_MIC_SIZE / 2,
              backgroundColor: pressed ? colors.divider : 'transparent',
            })}
            accessibilityRole="button"
            accessibilityLabel={
              disabled
                ? `Attach unavailable — ${disabledReason ?? 'disconnected'}`
                : 'Add to message'
            }
          >
            <Plus size={FIELD_MIC_ICON_SIZE} color={disabled ? colors.inkFaint : colors.ink3} />
          </Pressable>
        )}
      </View>
      {/* Action row. Everything that acts on the message is here, left to
          right; the send button is pushed to the RIGHT edge by the flexible
          spacer, keeping it where the thumb already expects it. */}
      <View
        testID="composer-actions-row"
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, minWidth: 0 }}
      >
        {/* Settings (spec/15 § Composer): the standing settings for the next
            turn, as icons so the row stays one line — approval mode, model
            by its short name, account, effort. Same order as web. */}
        {sendTarget === undefined && !edit ? (
          <View
            testID="composer-settings-row"
            style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1 }}
          >
            <Pressable
              testID="permission-mode-padlock"
              onPress={() => setModeMenuOpen(true)}
              // A mode change is a socket frame with nothing to queue it into —
              // disabled, visibly, rather than dropped (spec/12).
              disabled={linkDown}
              style={({ pressed }) => ({
                minWidth: ACTION_SIZE,
                height: ACTION_SIZE,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                paddingHorizontal: space.xs,
                borderRadius: radii.md,
                backgroundColor: pressed ? colors.divider : 'transparent',
              })}
              accessibilityRole="button"
              accessibilityLabel={`Permission mode: ${
                permissionMode === undefined
                  ? 'not reported yet'
                  : permissionModeLabel(permissionMode)
              }`}
            >
              <ModeIcon
                size={ICON_SIZE}
                color={linkDown ? colors.inkFaint : bypass ? colors.red : colors.ink2}
              />
              {permissionMode !== undefined ? (
                <Text
                  style={{
                    ...typography.meta,
                    color: linkDown ? colors.inkFaint : bypass ? colors.red : colors.ink3,
                  }}
                >
                  {permissionModeShortLabel(permissionMode)}
                </Text>
              ) : null}
            </Pressable>
            <ModelPicker
              hostId={row?.hostId ? row.hostId : null}
              selected={pendingModel ?? chatModel}
              pending={pendingModel !== null}
              onSelect={chooseModel}
              disabled={linkDown}
              variant="compact"
              testID="composer-model-pill"
              note={
                running
                  ? 'Applies to your next message — this turn keeps its model'
                  : 'Applies to your next message'
              }
            />
            {row?.account ? (
              <Pressable
                testID="chat-account"
                onPress={() => setAccountMenuOpen(true)}
                style={({ pressed }) => ({
                  width: ACTION_SIZE,
                  height: ACTION_SIZE,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: radii.md,
                  backgroundColor: pressed ? colors.divider : 'transparent',
                })}
                accessibilityRole="button"
                accessibilityLabel={`Account: ${row.account.label}`}
              >
                <UserRound size={ICON_SIZE} color={colors.ink2} />
              </Pressable>
            ) : null}
            {showEffort ? (
              <Pressable
                testID="composer-effort"
                onPress={() => setEffortMenuOpen(true)}
                disabled={linkDown}
                style={({ pressed }) => ({
                  minWidth: ACTION_SIZE,
                  height: ACTION_SIZE,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  paddingHorizontal: space.xs,
                  borderRadius: radii.md,
                  backgroundColor: pressed ? colors.divider : 'transparent',
                  opacity: pendingEffort !== null ? 0.55 : 1,
                })}
                accessibilityRole="button"
                accessibilityLabel={`Thinking effort: ${effortShown === null ? 'the model decides' : EFFORT_LABELS[effortShown]}`}
              >
                <Gauge size={ICON_SIZE} color={linkDown ? colors.inkFaint : colors.ink2} />
                <Text
                  style={{ ...typography.meta, color: linkDown ? colors.inkFaint : colors.ink3 }}
                >
                  {effortShown !== null ? EFFORT_LABELS[effortShown] : 'Effort'}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <View testID="composer-actions-spacer" style={{ flex: 1, minWidth: space.xs }} />
        {sendTarget === undefined && !edit ? (
          <ContextRing chatId={chatId} size={ACTION_SIZE} />
        ) : null}
        {edit ? (
          <>
            <Pressable
              testID="queued-edit-cancel"
              accessibilityRole="button"
              accessibilityLabel="Cancel edit"
              onPress={edit.onCancel}
              hitSlop={8}
            >
              <Text style={{ ...typography.meta, color: colors.ink3 }}>Cancel</Text>
            </Pressable>
            <Pressable
              testID="queued-edit-save"
              accessibilityRole="button"
              accessibilityLabel="Save edit"
              onPress={submit}
              hitSlop={8}
            >
              <Text style={{ ...typography.meta, color: colors.leaf, fontWeight: '600' }}>
                Save
              </Text>
            </Pressable>
          </>
        ) : showStop ? (
          <Pressable
            testID="composer-stop"
            onPress={stopTurn}
            disabled={linkDown}
            hitSlop={SEND_STOP_HIT_SLOP}
            style={({ pressed }) => ({
              width: SEND_STOP_VISUAL_SIZE,
              height: SEND_STOP_VISUAL_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radii.pill,
              backgroundColor: linkDown ? colors.divider : pressed ? colors.inkFaint : colors.ink2,
            })}
            accessibilityRole="button"
            accessibilityLabel={
              linkDown ? `Stop unavailable — ${linkReason ?? 'disconnected'}` : 'Stop turn'
            }
          >
            <Square size={STOP_ICON_SIZE} color={colors.paperRaised} fill={colors.paperRaised} />
          </Pressable>
        ) : (
          <Pressable
            onPress={submit}
            disabled={sendDisabled}
            hitSlop={SEND_STOP_HIT_SLOP}
            style={({ pressed }) => ({
              width: SEND_STOP_VISUAL_SIZE,
              height: SEND_STOP_VISUAL_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radii.pill,
              backgroundColor: sendLooksInactive
                ? colors.divider
                : pressed
                  ? colors.leafSoft
                  : colors.leaf,
            })}
            accessibilityRole="button"
            accessibilityLabel={
              hookChecking
                ? 'Checking…'
                : resolving
                  ? 'Sending — creating the chat'
                  : pendingSend
                    ? 'Sending…'
                    : linkDown || daemon !== 'online'
                      ? 'Send message (queued until the agent reconnects)'
                      : running
                        ? 'Send message (queued after the current turn)'
                        : 'Send message'
            }
          >
            {sendBusy ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <ArrowUp size={SEND_ICON_SIZE} color={colors.onAccent} />
            )}
          </Pressable>
        )}
      </View>
      <AnchoredMenu
        visible={addMenuOpen}
        items={[
          { id: 'camera', label: 'Take photo', testID: 'add-menu-camera' },
          { id: 'image', label: 'Photo or image', testID: 'add-menu-image' },
          { id: 'file', label: 'Any file', testID: 'add-menu-file' },
          { id: 'sketch', label: 'Sketch', testID: 'add-menu-sketch' },
        ]}
        onSelect={(id) => {
          setAddMenuOpen(false);
          // The + is disabled while the host can't take a file; a menu left
          // open across that change must not act on it either.
          if (disabled || resolving) return;
          if (id === 'camera') void takePhoto();
          else if (id === 'image') void pickImage();
          else if (id === 'file') void pickDocument();
          else if (id === 'sketch') setSketching(true);
        }}
        onDismiss={() => setAddMenuOpen(false)}
        placement="bottom"
        nonModal
      />
      {row?.account ? (
        <AnchoredMenu
          visible={accountMenuOpen}
          items={[
            {
              id: 'account',
              label: `On ${row.account.label}`,
              testID: 'account-menu-current',
              disabled: true,
            },
          ]}
          onSelect={() => setAccountMenuOpen(false)}
          onDismiss={() => setAccountMenuOpen(false)}
          placement="bottom"
          nonModal
        />
      ) : null}
      <AnchoredMenu
        visible={micMenuOpen}
        items={[
          { id: 'keep-dictating', label: 'Keep dictating', testID: 'mic-menu-keep-dictating' },
        ]}
        onSelect={(id) => {
          setMicMenuOpen(false);
          if (id === 'keep-dictating') startDictMode();
        }}
        onDismiss={() => setMicMenuOpen(false)}
        placement="bottom"
        nonModal
      />
      <AnchoredMenu
        visible={modeMenuOpen}
        items={modeItems}
        onSelect={onModeSelect}
        onDismiss={() => setModeMenuOpen(false)}
        placement="bottom"
        // Modal's Android focus-steal would close the keyboard mid-type
        // (Todoist 6hfvvHWp6QqVjjQ6) — see AnchoredMenu's `nonModal` doc.
        nonModal
      />
      <AnchoredMenu
        visible={effortMenuOpen}
        items={effortItems}
        onSelect={onEffortSelect}
        onDismiss={() => setEffortMenuOpen(false)}
        placement="bottom"
        nonModal
      />
      <ProviderSwitchModal
        visible={providerSwitchTarget !== null}
        onCancel={() => setProviderSwitchTarget(null)}
        onSwitch={(dontShowAgain) => {
          const target = providerSwitchTarget;
          setProviderSwitchTarget(null);
          if (dontShowAgain) {
            void useSettingsStore
              .getState()
              .updatePreferences({ suppressProviderSwitchWarning: true })
              .catch((e: Error) =>
                useUiStore.getState().pushError(`settings failed: ${e.message}`),
              );
          }
          if (target !== null) sendModelChange(target);
        }}
      />
      <SkillPreviewSheet
        skill={previewSkill}
        frontmatter={skillFrontmatter}
        paths={skillPaths}
        hostId={row?.hostId ?? ''}
        onClose={() => setPreviewSkill(null)}
      />
    </View>
  );
}

/** A soft ring that swells and fades behind the mic while it is listening. */
function ListeningRing({
  active,
  color,
}: {
  active: boolean;
  color: string;
}): React.ReactElement | null {
  const t = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    if (!active) return;
    t.setValue(0);
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: 1200,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, t]);
  if (!active) return null;
  return (
    <Animated.View
      testID="mic-listening-ring"
      pointerEvents="none"
      style={{
        position: 'absolute',
        width: FIELD_MIC_SIZE,
        height: FIELD_MIC_SIZE,
        borderRadius: FIELD_MIC_SIZE / 2,
        backgroundColor: color,
        opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.28, 0] }),
        transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.15] }) }],
      }}
    />
  );
}
