// Meeting mode: the meeting sits across the top of the chat, full width, with a
// bar under it that drags to give the meeting or the chat more room. One feed
// carries the meeting: topics summarised at the top (folded the further back
// they are), research and notes in among them, then the actions to deal with,
// then what was just said. The transcript is the other view. Pure view of the
// host's MeetingState; every control goes through lib/meetingControl.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Copy,
  List,
  MessageSquareText,
  Pause,
  Play,
  Plus,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import {
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_NOW_PROMPT,
  MEETING_CLEANUP_INSTRUCTIONS,
  MEETING_NOTES_FRAME,
  MEETING_RESEARCH_INSTRUCTIONS,
  MEETING_RESEARCH_RULES,
  MEETING_WRITEUP_INSTRUCTIONS,
  formatMeetingClock,
  meetingSpeakerLabel,
  meetingElapsedMs,
  MEETING_OWNER_EVERYONE,
  type MeetingAction,
  type MeetingCard,
  type MeetingState,
  type MeetingTopic,
} from '@patch/wire';
import {
  addAction,
  assignAction,
  decideAction,
  setActionTitle,
  setMeetingResearch,
  addNote,
  editMeetingNotes,
  editNote,
  endMeeting,
  getMeetingSpeed,
  listenHere,
  nameMeetingVoice,
  MEETING_SPEEDS,
  meetingSpeeds,
  setMeetingSpeed,
  pauseMeeting,
  requestMeeting,
  resumeMeeting,
  resumeEndedMeeting,
  saveWriteup,
} from '../lib/meetingControl.js';
import { writeupBodyHtml, writeupFromBody, writeupText } from '../lib/meetingWriteup.js';
import { isMeetingShown, useMeetingStore, type MeetingView } from '../stores/meetingStore.js';
import { parseMeetingNotes, type MeetingNote } from '../lib/meetingNotes.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import type { AccountPreferences } from '../api/rest.js';
import { patchShared } from '../routes/settings/sharedWrite.js';
import { MeetingModelRows } from '../routes/settings/PromptsPage.js';
import { Group } from '../routes/settings/ui.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { deriveBadge, useChatStore } from '../stores/chatStore.js';
import type { DisplayBadge } from '../stores/types.js';

const DECISION = /^Decision:\s*/;

function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, [running]);
  return now;
}

/** The named speed matching what the host is running, else the saved choice. */
function speedOf(meeting: MeetingState): string {
  const cur = meeting.settings;
  const hit = cur
    ? Object.entries(meetingSpeeds()).find(
        ([, v]) => v.clipSeconds === cur.clipSeconds && v.analyseSeconds === cur.analyseSeconds,
      )
    : undefined;
  return hit ? hit[0] : getMeetingSpeed();
}

type PromptKey = 'now' | 'notes' | 'actions';

const PROMPT_FIELDS: Record<
  PromptKey,
  { title: string; when: string; field: keyof AccountPreferences; fallback: string }
> = {
  now: {
    title: 'Now',
    when: 'each notes pass',
    field: 'meetingNowPrompt',
    fallback: DEFAULT_MEETING_NOW_PROMPT,
  },
  notes: {
    title: 'Notes',
    when: 'each notes pass',
    field: 'meetingNotesPrompt',
    fallback: DEFAULT_MEETING_NOTES_PROMPT,
  },
  actions: {
    title: 'Actions',
    when: 'each notes pass',
    field: 'meetingActionsPrompt',
    fallback: DEFAULT_MEETING_ACTIONS_PROMPT,
  },
};

/** The passes whose instructions are fixed in the host: shown so it is clear what each is told. */
const FIXED_PROMPTS: Array<{ id: string; title: string; when: string; text: string }> = [
  {
    id: 'frame',
    title: 'Notes pass (around the three above)',
    when: 'each notes pass',
    text: MEETING_NOTES_FRAME.join('\n'),
  },
  {
    id: 'cleanup',
    title: 'Transcript clean-up',
    when: 'before each notes pass',
    text: MEETING_CLEANUP_INSTRUCTIONS.join('\n'),
  },
  {
    id: 'research',
    title: 'Research',
    when: 'on new talk',
    text: [...MEETING_RESEARCH_INSTRUCTIONS, '', ...MEETING_RESEARCH_RULES].join('\n'),
  },
  {
    id: 'writeup',
    title: 'Write-up',
    when: 'when the meeting ends',
    text: MEETING_WRITEUP_INSTRUCTIONS.join('\n'),
  },
];

/** One editable meeting prompt, folded to its name until opened; applies from the next pass. */
function PromptBlock({ k }: { k: PromptKey }) {
  const { title, when, field, fallback } = PROMPT_FIELDS[k];
  const saved = usePreferencesStore((s) => String(s.preferences[field]));
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(saved);
  // Reload the text when it is opened, not on every preference push mid-typing.
  useEffect(() => {
    if (open) setDraft(saved);
  }, [open]);
  const save = (text: string) =>
    void patchShared(`${title.toLowerCase()} prompt`, { [field]: text });
  return (
    <div className="mm-prompt" data-testid={`meeting-prompt-${k}`} data-open={open}>
      <button
        type="button"
        className="mm-prompt-h"
        aria-expanded={open}
        data-testid={`meeting-prompt-open-${k}`}
        onClick={() => setOpen(!open)}
      >
        <span>{title}</span>
        <span className="mm-prompt-when">{when}</span>
      </button>
      {open ? (
        <>
          <textarea
            aria-label={`${title} prompt`}
            data-testid="meeting-prompt-text"
            rows={6}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="mm-prompt-actions">
            <button
              type="button"
              className="mm-btn"
              data-testid="meeting-prompt-reset"
              onClick={() => {
                setDraft(fallback);
                save(fallback);
              }}
            >
              Reset to default
            </button>
            <button
              type="button"
              className="mm-do"
              data-testid="meeting-prompt-save"
              onClick={() => save(draft)}
            >
              Save
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function FixedPromptBlock({ p }: { p: (typeof FIXED_PROMPTS)[number] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mm-prompt" data-testid={`meeting-prompt-${p.id}`} data-open={open}>
      <button
        type="button"
        className="mm-prompt-h"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>{p.title}</span>
        <span className="mm-prompt-when">{p.when} · fixed</span>
      </button>
      {open ? <pre className="mm-prompt-fixed">{p.text}</pre> : null}
    </div>
  );
}

/** Who is on the call, as far as speaker detection has named them. */
/** A speaker as Tom reads it: a voice the meeting has no name for is "Unknown", not "Them". */
export function speakerDisplay(
  line: Pick<MeetingState['transcript'][number], 'speaker' | 'voice' | 'name'>,
  voices?: Record<string, string>,
): string {
  const label = meetingSpeakerLabel(line, voices);
  if (label === 'Them') return 'Unknown';
  if (
    line.speaker === 'them' &&
    line.name === undefined &&
    voices?.[String(line.voice)] === undefined
  )
    return label.replace(/^Them /, 'Unknown ');
  return label;
}

/** "Them: …" and "Them 2: …" at the start of a point read as "Unknown: …". */
function unknownSpeaker(text: string): string {
  return text.replace(/^Them( \d+)?:/, (_m, n: string | undefined) => `Unknown${n ?? ''}:`);
}

function participantsOf(meeting: MeetingState): string[] {
  const names: string[] = [];
  let unknown = 0;
  const seenUnknown = new Set<string>();
  for (const l of meeting.transcript) {
    const named = l.name !== undefined || meeting.voices?.[String(l.voice)] !== undefined;
    if (l.speaker === 'them' && !named) {
      const k = String(l.voice ?? 0);
      if (!seenUnknown.has(k)) {
        seenUnknown.add(k);
        unknown++;
      }
      continue;
    }
    const n = speakerDisplay(l, meeting.voices);
    if (!names.includes(n)) names.push(n);
  }
  if (unknown > 0) names.push(`${unknown} unknown`);
  return names;
}

/** A line's speaker; an unnamed voice is a button that asks who it is. */
function SpeakerName({
  chatId,
  meeting,
  line: l,
}: {
  chatId: string;
  meeting: MeetingState;
  line: MeetingState['transcript'][number];
}) {
  if (l.voice === undefined || l.name !== undefined)
    return <b>{speakerDisplay(l, meeting.voices)}</b>;
  return (
    <button
      type="button"
      className="mm-voice"
      data-testid="meeting-voice"
      onClick={() => {
        const name = window.prompt('Who is this?', meeting.voices?.[String(l.voice)] ?? '');
        if (name && name.trim() !== '') nameMeetingVoice(chatId, l.voice!, name.trim());
      }}
    >
      <b>{speakerDisplay(l, meeting.voices)}</b>
    </button>
  );
}

const openActions = (meeting: MeetingState) =>
  meeting.actions.filter((a) => a.status !== 'dismissed');

/** The timer: a red dot while live, "Paused ·" while paused, the duration alone once ended. */
function MeetingPill({ meeting, prefix }: { meeting: MeetingState; prefix?: string }) {
  const now = useNow(meeting.status === 'live');
  const elapsed = meetingElapsedMs(meeting, now);
  return (
    <span
      className={meeting.status === 'ended' ? 'mm-pill ended' : 'mm-pill'}
      data-testid="meeting-pill"
    >
      {meeting.status === 'live' ? <span className="mm-dot" /> : null}
      {prefix ?? (meeting.status === 'paused' ? 'Paused · ' : '')}
      {formatMeetingClock(elapsed)}
    </span>
  );
}

function People({ meeting }: { meeting: MeetingState }) {
  const people = participantsOf(meeting);
  return people.length > 0 ? (
    <span className="mm-people" data-testid="meeting-people" title={people.join(', ')}>
      {people.join(' · ')}
    </span>
  ) : (
    <span className="mm-sp" />
  );
}

/** The panel's one header row: the two views on the left; timer, controls and settings on the right. */
function MeetingHead({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const view = useMeetingStore((s) => s.view[chatId] ?? 'notes');
  const setView = useMeetingStore((s) => s.setView);
  const setFolded = useMeetingStore((s) => s.setFolded);
  const settingsOpen = useMeetingStore((s) => s.settingsOpen);
  const setSettingsOpen = useMeetingStore((s) => s.setSettingsOpen);
  const ended = meeting.status === 'ended';
  const show = (v: MeetingView) => {
    setView(chatId, v);
    setSettingsOpen(false);
  };
  return (
    <div className="mm-head" data-testid="meeting-bar" data-status={meeting.status}>
      <button
        type="button"
        className="mm-icon"
        data-testid="meeting-view-notes"
        aria-label="Notes"
        title="Notes"
        aria-pressed={!settingsOpen && view === 'notes'}
        onClick={() => show('notes')}
      >
        <List size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="mm-icon"
        data-testid="meeting-view-transcript"
        aria-label="Transcript"
        title="Transcript"
        aria-pressed={!settingsOpen && view === 'transcript'}
        onClick={() => show('transcript')}
      >
        <MessageSquareText size={16} aria-hidden="true" />
      </button>
      <People meeting={meeting} />
      <MeetingPill meeting={meeting} />
      {meeting.status === 'live' ? (
        <button
          type="button"
          className="mm-icon"
          data-testid="meeting-pause"
          aria-label="Pause"
          title="Pause"
          onClick={() => pauseMeeting(chatId)}
        >
          <Pause size={16} aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          className="mm-icon"
          data-testid="meeting-resume"
          aria-label="Resume"
          title="Resume"
          onClick={() => (ended ? void resumeEndedMeeting(chatId) : resumeMeeting(chatId))}
        >
          <Play size={16} aria-hidden="true" />
        </button>
      )}
      {!ended ? (
        <button
          type="button"
          className="mm-icon mm-end-icon"
          data-testid="meeting-end"
          aria-label="End"
          title="End"
          onClick={() => endMeeting(chatId)}
        >
          <Square size={14} aria-hidden="true" />
        </button>
      ) : null}
      {ended && meeting.writeup ? <CopyWriteup meeting={meeting} /> : null}
      <button
        type="button"
        className="mm-icon"
        data-testid="meeting-cog"
        aria-label="Meeting settings"
        title="Meeting settings"
        aria-pressed={settingsOpen}
        onClick={() => setSettingsOpen(!settingsOpen)}
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
      </button>
      {ended ? (
        <button
          type="button"
          className="mm-icon"
          data-testid="meeting-fold"
          aria-label="Fold the meeting away"
          title="Fold the meeting away"
          aria-expanded="true"
          onClick={() => {
            setSettingsOpen(false);
            setFolded(chatId, true);
          }}
        >
          <ChevronUp size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** Copies the write-up as plain text, for sending on to the group. */
function CopyWriteup({ meeting }: { meeting: MeetingState }) {
  const [copied, setCopied] = useState(false);
  const meta = `${new Date(meeting.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${Math.max(1, Math.round(meeting.elapsedBaseMs / 60_000))} min`;
  return (
    <button
      type="button"
      className="mm-icon"
      data-testid="meeting-copy"
      aria-label="Copy write-up"
      title={copied ? 'Copied' : 'Copy write-up'}
      onClick={() =>
        void navigator.clipboard.writeText(writeupText(meeting.writeup!, meta)).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
    </button>
  );
}

/** An ended meeting folded away: one thin line over the chat, with a way back to its notes or transcript. */
function FoldedBar({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const setView = useMeetingStore((s) => s.setView);
  const setFolded = useMeetingStore((s) => s.setFolded);
  const show = (v: MeetingView) => {
    setView(chatId, v);
    setFolded(chatId, false);
  };
  return (
    <section
      className="mm-bar folded"
      data-testid="meeting-bar"
      data-status={meeting.status}
      data-folded="true"
    >
      <div className="mm-head">
        <MeetingPill meeting={meeting} prefix="Meeting · " />
        <People meeting={meeting} />
        <button
          type="button"
          className="mm-icon"
          data-testid="meeting-open-summary"
          aria-label="Notes"
          title="Notes"
          onClick={() => show('notes')}
        >
          <List size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mm-icon"
          data-testid="meeting-open-transcript"
          aria-label="Transcript"
          title="Transcript"
          onClick={() => show('transcript')}
        >
          <MessageSquareText size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mm-icon"
          data-testid="meeting-fold"
          aria-label="Show the meeting"
          title="Show the meeting"
          aria-expanded="false"
          onClick={() => setFolded(chatId, false)}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

/** One error, one line; the whole text is on hover, and a click shows it in full. */
function AlertLine({
  testid,
  text,
  children,
}: {
  testid: string;
  text: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="mm-alert"
      role="alert"
      data-testid={testid}
      data-open={open}
      title={text}
      onClick={() => setOpen(!open)}
    >
      <span className="mm-alert-t">{text}</span>
      {children}
    </div>
  );
}

/** Everything that has gone wrong with the meeting, under the tabs. */
function MeetingAlerts({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const capturing = useMeetingStore((s) => s.capturingChatId === chatId);
  const notListening = meeting.status === 'live' && !capturing;
  if (!meeting.error && !meeting.researchError && !notListening) return null;
  return (
    <div className="mm-alerts">
      {meeting.error ? <AlertLine testid="meeting-error" text={meeting.error} /> : null}
      {meeting.researchError ? (
        <AlertLine testid="meeting-research-error" text={meeting.researchError} />
      ) : null}
      {notListening ? (
        <AlertLine testid="meeting-not-listening" text="This device is not listening">
          <button
            type="button"
            className="mm-btn"
            data-testid="meeting-listen-here"
            onClick={(e) => {
              e.stopPropagation();
              void listenHere(chatId);
            }}
          >
            Listen here
          </button>
        </AlertLine>
      ) : null}
    </div>
  );
}

/** The meeting's switch: the agent researching what is said as the call goes. */
export function MeetingSwitches({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  return (
    <div className="mm-switches">
      <label className="mm-switch">
        <input
          type="checkbox"
          data-testid="meeting-research-on"
          checked={meeting.researchOn === true}
          disabled={meeting.status === 'ended'}
          onChange={(e) => setMeetingResearch(chatId, e.target.checked)}
        />
        Agent researches during call
      </label>
    </div>
  );
}

/** What the settings button opens: the switch, how often notes update, models, and every prompt. */
function MeetingSettingsPane({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  return (
    <div className="mm-settings" data-testid="meeting-settings">
      <MeetingSwitches chatId={chatId} meeting={meeting} />
      {meeting.status !== 'ended' ? (
        <label className="mm-speed">
          Notes update
          <select
            data-testid="meeting-speed"
            value={speedOf(meeting)}
            onChange={(e) => setMeetingSpeed(chatId, e.target.value)}
          >
            {Object.entries(MEETING_SPEEDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <Group label="Models and timing" testid="meeting-models">
        <MeetingModelRows />
      </Group>
      <div className="mm-label">Prompts</div>
      <div className="mm-prompts" data-testid="meeting-prompts">
        {(Object.keys(PROMPT_FIELDS) as PromptKey[]).map((k) => (
          <PromptBlock key={k} k={k} />
        ))}
        {FIXED_PROMPTS.map((p) => (
          <FixedPromptBlock key={p.id} p={p} />
        ))}
      </div>
    </div>
  );
}

const MAX_LINES_BEHIND = 12;

/**
 * Text that is edited where it stands. It commits on blur; Enter commits and
 * calls `onEnter`; Escape puts the old text back. Plain text only.
 */
function Editable({
  value,
  onCommit,
  onEnter,
  autoFocus,
  onFocused,
  testid,
  className,
  placeholder,
  label,
}: {
  value: string;
  /** Called on blur with the trimmed text, changed or not. */
  onCommit: (text: string) => void;
  onEnter?: (text: string) => void;
  autoFocus: boolean;
  onFocused: () => void;
  testid: string;
  className?: string;
  placeholder: string;
  label: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== value) el.textContent = value;
  }, [value]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !autoFocus) return;
    el.focus();
    const sel = window.getSelection();
    sel?.selectAllChildren(el);
    sel?.collapseToEnd();
    onFocused();
    // Focus once when asked, not on every render while it is still asked for.
  }, [autoFocus]);
  return (
    <span
      ref={ref}
      className={className}
      data-testid={testid}
      data-placeholder={placeholder}
      aria-label={label}
      role="textbox"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck
      onBlur={(e) => onCommit((e.currentTarget.textContent ?? '').trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onEnter?.((e.currentTarget.textContent ?? '').trim());
        } else if (e.key === 'Escape') {
          e.currentTarget.textContent = value;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** "0:00–9:40 · 10 min": where a topic sits in the call and how long it ran. */
export function topicSpanLabel(start: number, end: number): string {
  const mins = Math.max(1, Math.round((end - start) / 60_000));
  return `${formatMeetingClock(start)}–${formatMeetingClock(end)} · ${mins} min`;
}

/** Something raised during a topic: research, one of Tom's notes, or an action. */
export type FeedItem =
  | { kind: 'card'; at: number; card: MeetingCard }
  | { kind: 'note'; at: number; note: MeetingNote }
  | { kind: 'action'; at: number; action: MeetingAction };

/** One topic with the time it ran and what came up in it. */
export interface FeedTopic {
  topic: MeetingTopic;
  start: number;
  end: number;
  items: FeedItem[];
}

/**
 * The feed's shape: topics oldest first, each running until the next one starts
 * (the last until `endMs`), with research, notes and actions filed under the
 * topic they came up in. Anything raised before the first topic is `before`.
 */
export function feedTopics(
  meeting: Pick<MeetingState, 'topics' | 'cards' | 'actions' | 'myNotes'>,
  endMs: number,
): { before: FeedItem[]; topics: FeedTopic[] } {
  const sorted = [...meeting.topics].sort((a, b) => a.at - b.at);
  const items: FeedItem[] = [
    ...(meeting.cards ?? []).map((card) => ({ kind: 'card' as const, at: card.at, card })),
    ...parseMeetingNotes(meeting.myNotes ?? '').map((note) => ({
      kind: 'note' as const,
      at: note.at,
      note,
    })),
    ...meeting.actions
      .filter((a) => a.status !== 'dismissed')
      .map((action) => ({ kind: 'action' as const, at: action.at, action })),
  ].sort((a, b) => a.at - b.at);
  const topics = sorted.map((topic, i) => {
    const next = sorted[i + 1];
    const end = next ? next.at : Math.max(endMs, topic.at);
    return { topic, start: topic.at, end, items: [] as FeedItem[] };
  });
  const before: FeedItem[] = [];
  for (const item of items) {
    let home: FeedTopic | undefined;
    for (const t of topics) if (item.at >= t.start) home = t;
    if (home) home.items.push(item);
    else before.push(item);
  }
  return { before, topics };
}

/** The transcript lines a topic came from: from its start up to the next topic's. */
function linesBehind(meeting: MeetingState, start: number, end: number) {
  return meeting.transcript.filter((l) => l.at >= start && l.at < end).slice(0, MAX_LINES_BEHIND);
}

/** Which editable field should take the caret once it has rendered. */
interface PointFocus {
  topicId: string;
  /** `null` is the topic's summary line; a number is a bullet. */
  bullet: number | null;
}

/**
 * One topic: a chevron, its one-line summary and when it ran. Open, its
 * bullets and whatever came up in it. Every piece of text is edited in place.
 */
function TopicRow({
  chatId,
  meeting,
  ft,
  open,
  onToggle,
  focus,
  setFocus,
}: {
  chatId: string;
  meeting: MeetingState;
  ft: FeedTopic;
  open: boolean;
  onToggle: () => void;
  focus: PointFocus | null;
  setFocus: (f: PointFocus | null) => void;
}) {
  const t = ft.topic;
  const [said, setSaid] = useState(false);
  const decision = DECISION.exec(t.title);
  const titleText = unknownSpeaker(decision ? t.title.slice(decision[0].length) : t.title);
  const wants = (bullet: number | null) =>
    focus !== null && focus.topicId === t.id && focus.bullet === bullet;
  const edit = (e: Parameters<typeof editMeetingNotes>[1]) => editMeetingNotes(chatId, e);

  const commitTitle = (text: string) => {
    if (text === titleText) return;
    const full = decision ? `Decision: ${text}`.trim() : text;
    if (full !== t.title) edit({ op: 'set_title', topicId: t.id, text: full });
    if (text === '' && t.points.every((p) => p.trim() === '') && !decision)
      edit({ op: 'remove', topicId: t.id });
  };
  const commitBullet = (i: number, text: string) => {
    if (text === '') edit({ op: 'remove_bullet', topicId: t.id, index: i });
    else if (text !== t.points[i]) edit({ op: 'set_bullet', topicId: t.id, index: i, text });
  };
  const lines = open && said ? linesBehind(meeting, ft.start, ft.end) : [];

  return (
    <div
      className="mm-topic"
      data-testid="meeting-topic"
      data-open={open ? 'true' : undefined}
      data-decided={decision ? 'true' : undefined}
    >
      <div className="mm-topic-h">
        <button
          type="button"
          className="mm-chev"
          data-testid="meeting-topic-toggle"
          aria-expanded={open}
          aria-label={open ? 'Fold' : 'Open'}
          onClick={onToggle}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        <div className="nm">
          {decision ? <span className="decw">Decided</span> : null}
          <Editable
            value={titleText}
            testid="meeting-point-title"
            label="Topic"
            placeholder="What was discussed, who said what, where it landed"
            autoFocus={wants(null)}
            onFocused={() => setFocus(null)}
            onCommit={commitTitle}
            onEnter={(text) => {
              if (text === '') return (document.activeElement as HTMLElement | null)?.blur();
              commitTitle(text);
              edit({ op: 'add_bullet', topicId: t.id, index: 0 });
              setFocus({ topicId: t.id, bullet: 0 });
            }}
          />
        </div>
        <button
          type="button"
          className="mm-span"
          data-testid="meeting-point-time"
          title={open ? 'Show what was said' : 'Open'}
          aria-pressed={open && said}
          onClick={() => {
            if (!open) onToggle();
            setSaid(open ? !said : true);
          }}
        >
          {topicSpanLabel(ft.start, ft.end)}
        </button>
      </div>
      {open ? (
        <div className="mm-topic-b">
          {t.points.length > 0 ? (
            <ul>
              {t.points.map((p, i) => (
                <li key={i}>
                  <Editable
                    value={p}
                    testid="meeting-point-bullet"
                    label="Bullet"
                    placeholder="Detail"
                    autoFocus={wants(i)}
                    onFocused={() => setFocus(null)}
                    onCommit={(text) => commitBullet(i, text)}
                    onEnter={(text) => {
                      if (text === '')
                        return (document.activeElement as HTMLElement | null)?.blur();
                      commitBullet(i, text);
                      edit({ op: 'add_bullet', topicId: t.id, index: i + 1 });
                      setFocus({ topicId: t.id, bullet: i + 1 });
                    }}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          {ft.items.map((item) => (
            <FeedItemRow key={feedItemKey(item)} chatId={chatId} item={item} />
          ))}
          {said ? (
            <div className="mm-tx" data-testid="meeting-point-lines">
              {lines.length === 0 ? (
                <span className="mm-wait">No transcript for this topic</span>
              ) : null}
              {lines.map((l, i) => (
                <div key={i} data-testid="meeting-point-line">
                  <b>{speakerDisplay(l, meeting.voices)}</b> {l.text}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function feedItemKey(item: FeedItem): string {
  if (item.kind === 'card') return `c${item.card.id}`;
  if (item.kind === 'note') return `n${item.note.index}`;
  return `a${item.action.id}`;
}

function FeedItemRow({ chatId, item }: { chatId: string; item: FeedItem }) {
  if (item.kind === 'card') return <ResearchCard card={item.card} />;
  if (item.kind === 'note') return <NoteRow chatId={chatId} note={item.note} />;
  const a = item.action;
  return (
    <div className="mm-line" data-testid="meeting-feed-action" data-status={a.status}>
      <span className="mm-chip act">{a.kind === 'agent' ? 'Agent task' : 'Action'}</span>
      <span className="mm-line-t">
        {actionOwnerLabel(a) ? `${actionOwnerLabel(a)}: ` : ''}
        {a.title}
      </span>
    </div>
  );
}

/** One of Tom's own notes, in full ink where he wrote it; edited in place, emptied to remove. */
function NoteRow({ chatId, note }: { chatId: string; note: MeetingNote }) {
  return (
    <div className="mm-line mine" data-testid="meeting-note">
      <span className="mm-chip note">Note</span>
      <Editable
        value={note.text}
        testid="meeting-note-text"
        className="mm-line-t"
        label="Note"
        placeholder="Note"
        autoFocus={false}
        onFocused={() => {}}
        onCommit={(text) => {
          if (text !== note.text) editNote(chatId, note.index, text);
        }}
        onEnter={() => (document.activeElement as HTMLElement | null)?.blur()}
      />
    </div>
  );
}

/** How far back "Just said" reaches: the last half minute, and never fewer than a few lines. */
const JUST_SAID_MS = 30_000;
const JUST_SAID_MIN_LINES = 4;

/** The last stretch of talk, word for word: for "what did they just say?". */
export function justSaid(transcript: MeetingState['transcript']): MeetingState['transcript'] {
  const last = transcript.at(-1);
  if (!last) return [];
  const recent = transcript.filter((l) => l.at >= last.at - JUST_SAID_MS);
  return recent.length >= JUST_SAID_MIN_LINES ? recent : transcript.slice(-JUST_SAID_MIN_LINES);
}

function JustSaid({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const lines = justSaid(meeting.transcript);
  if (lines.length === 0) return null;
  return (
    <div className="mm-said" data-testid="meeting-tail">
      <div className="mm-sect">Just said</div>
      {lines.map((l, i) => (
        <div key={`${l.at}-${i}`} data-testid="meeting-line" className="mm-ln">
          <SpeakerName chatId={chatId} meeting={meeting} line={l} />
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The one feed: topics oldest first — the newest open while live, the rest
 * folded to their summary line — then the actions, then while live what was
 * just said. Once ended, the write-up heads it, folded.
 */
function Feed({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const [focus, setFocus] = useState<PointFocus | null>(null);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const live = meeting.status !== 'ended';
  const now = useNow(meeting.status === 'live');
  const endMs = live ? meetingElapsedMs(meeting, now) : meeting.elapsedBaseMs;
  const { before, topics } = useMemo(
    () => feedTopics(meeting, endMs),
    [meeting.topics, meeting.cards, meeting.actions, meeting.myNotes, endMs],
  );
  const newest = topics.at(-1)?.topic.id;
  const toggle = (id: string) =>
    setToggled((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Live, the newest stays in view; once ended, the top does.
  const scroller = usePinnedScroll(
    [topics.length, meeting.transcript.length, meeting.actions],
    live,
  );

  return (
    <div className="mm-scroll" data-testid="meeting-points" ref={scroller}>
      <div className="mm-col mm-feed">
        {!live ? <WriteupFold chatId={chatId} meeting={meeting} /> : null}
        {topics.length === 0 && before.length === 0 && live ? (
          <div className="mm-wait">Listening…</div>
        ) : null}
        {before.map((item) => (
          <FeedItemRow key={feedItemKey(item)} chatId={chatId} item={item} />
        ))}
        {topics.map((ft) => {
          const id = ft.topic.id;
          const open = (live && id === newest) !== toggled.has(id);
          return (
            <TopicRow
              key={id}
              chatId={chatId}
              meeting={meeting}
              ft={ft}
              open={open}
              onToggle={() => toggle(id)}
              focus={focus}
              setFocus={setFocus}
            />
          );
        })}
        {live ? (
          <AddLine
            label="Add note"
            testid="meeting-note-add"
            onAdd={(text) => addNote(chatId, text)}
          />
        ) : null}
        <ActionsList chatId={chatId} meeting={meeting} />
        {live ? <JustSaid chatId={chatId} meeting={meeting} /> : null}
      </div>
    </div>
  );
}

/** Keeps a scroller at the bottom as content arrives, unless Tom has scrolled up to read. */
function usePinnedScroll(deps: unknown[], pin = true) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(pin);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    pinned.current = pin;
  }, [pin]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, deps);
  return ref;
}

/** The whole transcript, earliest first, with a copy button that stays at the top. */
function TranscriptList({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const scroller = usePinnedScroll([meeting.transcript.length]);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = meeting.transcript
      .map((l) => `${formatMeetingClock(l.at)} ${speakerDisplay(l, meeting.voices)}: ${l.text}`)
      .join('\n');
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="mm-scroll" ref={scroller}>
      <div className="mm-col mm-transcript" data-testid="meeting-transcript">
        <div className="mm-tx-head">
          <span className="mm-sp" />
          <button
            type="button"
            className="mm-icon"
            data-testid="meeting-transcript-copy"
            aria-label="Copy transcript"
            title={copied ? 'Copied' : 'Copy transcript'}
            onClick={copy}
          >
            {copied ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <Copy size={16} aria-hidden="true" />
            )}
          </button>
        </div>
        {meeting.transcript.length === 0 ? <div className="mm-wait">No transcript</div> : null}
        {meeting.transcript.map((l, i) => (
          <div key={i} data-testid="meeting-line" className="mm-ln">
            <span className="tm">{formatMeetingClock(l.at)}</span>
            <span>
              <SpeakerName chatId={chatId} meeting={meeting} line={l} /> {l.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The write-up, once the meeting has ended: folded to one line at the top of
 * the feed, open to read or edit. Its title names the chat. Tom's words are
 * dark ink, generated text softer, and names the clean-up pass fixed are
 * underlined with the original on hover.
 */
function WriteupFold({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const [open, setOpen] = useState(false);
  const w = meeting.writeup ?? null;
  const failure = meeting.writeupError;
  return (
    <div
      className="mm-topic mm-writeup"
      data-testid="meeting-summary"
      data-open={open ? 'true' : undefined}
    >
      <div className="mm-topic-h">
        <button
          type="button"
          className="mm-chev"
          data-testid="meeting-writeup-toggle"
          aria-expanded={open}
          aria-label={open ? 'Fold' : 'Open'}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        <div className="nm">
          <span className="mm-chip">Write-up</span>
          {w ? null : failure ? null : (
            <span className="mm-wait" data-testid="meeting-writeup-wait">
              Writing…
            </span>
          )}
        </div>
      </div>
      {failure ? (
        <div className="mm-error" role="alert" data-testid="meeting-writeup-error">
          {failure}
        </div>
      ) : null}
      {open && w ? <WriteupBody chatId={chatId} meeting={meeting} /> : null}
    </div>
  );
}

function WriteupBody({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const w = meeting.writeup!;
  const fixes = meeting.nameFixes ?? [];
  const bodyRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const html = useMemo(() => writeupBodyHtml(w, fixes), [w, fixes]);
  // Draw the host's version unless Tom is typing in it.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body && !body.contains(document.activeElement) && body.innerHTML !== html)
      body.innerHTML = html;
  }, [html]);
  const flush = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    saveWriteup(chatId, writeupFromBody(w.title, bodyRef.current ?? document.createElement('div')));
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="mm-sum">
      <div
        ref={bodyRef}
        className="body"
        data-testid="meeting-writeup-body"
        role="textbox"
        aria-multiline="true"
        aria-label="Write-up"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onInput={() => {
          clearTimeout(timer.current);
          timer.current = setTimeout(flush, 600);
        }}
        onBlur={flush}
      />
    </div>
  );
}

/** The panel across the top of the chat: one header row, errors, then the feed, the transcript or the settings. */
export function MeetingPanel({
  chatId,
  meeting,
  height,
}: {
  chatId: string;
  meeting: MeetingState;
  /** Share of the chat's height; omitted, the panel sizes to the stylesheet. */
  height?: number;
}) {
  const view = useMeetingStore((s) => s.view[chatId] ?? 'notes');
  const setView = useMeetingStore((s) => s.setView);
  const settingsOpen = useMeetingStore((s) => s.settingsOpen);
  const ended = meeting.status === 'ended';
  // A meeting that ends goes to the feed, where the write-up now heads the topics.
  const wasEnded = useRef(ended);
  useEffect(() => {
    if (ended === wasEnded.current) return;
    wasEnded.current = ended;
    if (ended) setView(chatId, 'notes');
  }, [ended, chatId, setView]);
  return (
    <aside
      className="mm-panel"
      data-testid="meeting-panel"
      data-status={meeting.status}
      style={height !== undefined ? { height: `${height * 100}%` } : undefined}
    >
      <MeetingHead chatId={chatId} meeting={meeting} />
      <MeetingAlerts chatId={chatId} meeting={meeting} />
      {settingsOpen ? (
        <div className="mm-scroll">
          <div className="mm-col">
            <MeetingSettingsPane chatId={chatId} meeting={meeting} />
          </div>
        </div>
      ) : view === 'transcript' ? (
        <TranscriptList chatId={chatId} meeting={meeting} />
      ) : (
        <Feed chatId={chatId} meeting={meeting} />
      )}
    </aside>
  );
}

const CARD_LABEL: Record<MeetingCard['kind'], string> = {
  explained: 'Explained',
  fact: 'Fact check',
  answer: 'Answer',
};
const VERDICT_LABEL = { correct: 'Correct', off: 'Off', unclear: 'Unclear' } as const;

/** A research card on one line: kind, what it is about, the verdict and source. Opens to its bullets. */
function ResearchCard({ card }: { card: MeetingCard }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mm-card" data-testid="meeting-card" data-kind={card.kind} data-open={open}>
      <button
        type="button"
        className="mm-line mm-card-h"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="mm-chip" data-testid="meeting-card-kind">
          {CARD_LABEL[card.kind]}
        </span>
        <span className="mm-line-t" data-testid="meeting-card-title">
          {card.title}
        </span>
        {card.verdict ? (
          <span
            className="mm-verdict"
            data-testid="meeting-card-verdict"
            data-verdict={card.verdict}
          >
            {VERDICT_LABEL[card.verdict]}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="mm-card-b">
          <ul>
            {card.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          {card.source ? (
            <a
              className="mm-card-src"
              data-testid="meeting-card-source"
              href={card.source.url}
              target="_blank"
              rel="noreferrer"
            >
              {card.source.name}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Under an agent reply: a chip for each change it made to the notes during that
 * reply. An edit belongs to the first agent message written at or after it.
 */
export function MeetingEditChips({
  chatId,
  seq,
  messageAt,
}: {
  chatId: string;
  seq: number;
  messageAt: number | undefined;
}) {
  const edits = useMeetingStore((s) => s.byChat[chatId]?.agentEdits);
  const timeline = useChatStore((s) => s.timelines[chatId]);
  if (!edits?.length || messageAt === undefined || !timeline) return null;
  const earlier = timeline.flatMap((e) =>
    e.kind === 'message' && e.role === 'assistant' && e.seq < seq && e.messageAt !== undefined
      ? [e.messageAt]
      : [],
  );
  const from = earlier.length ? Math.max(...earlier) : -Infinity;
  const mine = edits.filter((e) => e.at > from && e.at <= messageAt);
  if (!mine.length) return null;
  return (
    <div className="mm-edit-chips">
      {mine.map((e) => (
        <span key={e.id} className="mm-edit-chip" data-testid="meeting-edit-chip">
          ✓ {e.label}
        </span>
      ))}
    </div>
  );
}

const AGENT_STATE_LABEL: Record<DisplayBadge, string> = {
  working: 'Working…',
  permission: 'Needs you',
  errored: 'Failed',
  done: 'Done',
  background: 'Working…',
  monitoring: 'Working…',
  read: 'Done',
};

/** The live state of an action's chat, read from the chat list. A chat this client has not got says so. */
function ActionChatStatus({ chatId }: { chatId: string }) {
  const row = useChatStore((s) => s.chats[chatId]);
  return (
    <span className="mm-act-st" data-testid="meeting-action-status">
      {row ? AGENT_STATE_LABEL[deriveBadge(row)] : 'Chat not loaded'}
    </span>
  );
}

/** Who an action is for, as the row names them: You, Agent, or the person. */
function actionOwnerLabel(a: MeetingAction): string {
  if (a.kind === 'mine') return 'You';
  if (a.kind === 'agent') return 'Agent';
  return a.owner ?? MEETING_OWNER_EVERYONE;
}

/** The owner picker's value for an action: `mine`, `agent`, or `other:<name>`. */
function ownerValue(a: MeetingAction): string {
  return a.kind === 'other' ? `other:${a.owner ?? MEETING_OWNER_EVERYONE}` : a.kind;
}

/** Everyone the meeting knows by name, then Everyone. */
function knownPeople(meeting: MeetingState): string[] {
  const named = [
    ...meeting.transcript.flatMap((l) => (l.speaker === 'them' && l.name ? [l.name] : [])),
    ...Object.values(meeting.voices ?? {}),
    ...meeting.actions.flatMap((a) => (a.kind === 'other' && a.owner ? [a.owner] : [])),
  ].filter((n) => n !== MEETING_OWNER_EVERYONE);
  return [...new Set(named), MEETING_OWNER_EVERYONE];
}

function ActionRow({
  chatId,
  action,
  people,
}: {
  chatId: string;
  action: MeetingAction;
  people: string[];
}) {
  const done = action.status === 'done';
  return (
    <div
      className="mm-act"
      data-testid="meeting-action"
      data-kind={action.kind}
      data-status={action.status}
    >
      <input
        type="checkbox"
        className="mm-act-done"
        data-testid="meeting-action-done"
        aria-label={done ? 'Mark not done' : 'Mark done'}
        checked={done}
        onChange={() => decideAction(chatId, action.id, done ? 'reopen' : 'done')}
      />
      <select
        className="mm-act-owner"
        data-testid="meeting-action-owner"
        aria-label="Who"
        title="Change who"
        data-kind={action.kind}
        value={ownerValue(action)}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'mine' || v === 'agent') assignAction(chatId, action.id, v);
          else assignAction(chatId, action.id, 'other', v.slice('other:'.length));
        }}
      >
        <option value="mine">You</option>
        <option value="agent">Agent</option>
        {people.map((p) => (
          <option key={p} value={`other:${p}`}>
            {p}
          </option>
        ))}
      </select>
      <span className="mm-act-t" title={action.why !== '' ? action.why : undefined}>
        <Editable
          value={action.title}
          testid="meeting-action-title"
          label="Action"
          placeholder="Action"
          autoFocus={false}
          onFocused={() => {}}
          onCommit={(text) => {
            if (text !== '' && text !== action.title) setActionTitle(chatId, action.id, text);
          }}
          onEnter={() => (document.activeElement as HTMLElement | null)?.blur()}
        />
      </span>
      {action.chatId ? <ActionChatStatus chatId={action.chatId} /> : null}
      {action.chatId ? (
        <Link
          className="mm-act-btn"
          data-testid="meeting-action-open"
          to={`/chats/${action.chatId}`}
        >
          Open chat
        </Link>
      ) : done ? null : action.kind === 'agent' ? (
        <button
          type="button"
          className="mm-act-btn go"
          data-testid="meeting-action-do"
          onClick={() => decideAction(chatId, action.id, 'do')}
        >
          Approve
        </button>
      ) : action.kind === 'mine' ? (
        <button
          type="button"
          className="mm-act-btn"
          data-testid="meeting-action-chat"
          onClick={() => decideAction(chatId, action.id, 'chat')}
        >
          Start chat
        </button>
      ) : null}
      <button
        type="button"
        className="mm-act-x"
        data-testid="meeting-action-dismiss"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => decideAction(chatId, action.id, 'dismiss')}
      >
        ✕
      </button>
    </div>
  );
}

/** "+ Add …": a line that turns into a box; Enter or leaving it keeps what was typed. */
function AddLine({
  label,
  testid,
  onAdd,
}: {
  label: string;
  testid: string;
  onAdd: (text: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  if (!adding)
    return (
      <button type="button" className="mm-add" data-testid={testid} onClick={() => setAdding(true)}>
        <Plus size={14} aria-hidden="true" />
        {label}
      </button>
    );
  const finish = (keep: boolean) => {
    if (keep && draft.trim() !== '') onAdd(draft.trim());
    setAdding(false);
    setDraft('');
  };
  return (
    <input
      className="mm-add-input"
      data-testid={`${testid}-input`}
      aria-label={label}
      placeholder={label}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') finish(false);
      }}
    />
  );
}

/** Every action still to deal with, oldest first, one line each; done ones stay, ticked. */
export function ActionsList({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const open = openActions(meeting).sort((a, b) => a.at - b.at);
  const people = knownPeople(meeting);
  return (
    <div className="mm-actions" data-testid="meeting-actions">
      <div className="mm-sect">Actions</div>
      {open.map((a) => (
        <ActionRow key={a.id} chatId={chatId} action={a} people={people} />
      ))}
      <AddLine
        label="Add action"
        testid="meeting-action-add"
        onAdd={(text) => addAction(chatId, text, 'mine')}
      />
    </div>
  );
}

/**
 * Wraps the chat's stream + composer. With a meeting shown, the meeting's panel
 * sits across the top, full width, and the bar under it drags to share the
 * height with the chat below; an ended meeting folded away is one line over the
 * chat. Without one it is `display: contents`. The chat is always the third
 * slot, so the wrapped tree never remounts when a meeting starts, ends or folds.
 */
export function MeetingLayout({ chatId, children }: { chatId: string; children: ReactNode }) {
  const meeting = useMeetingStore((s) => s.byChat[chatId]);
  const folded = useMeetingStore((s) => s.folded[chatId] === true);
  const height = useMeetingStore((s) => s.height);
  const connection = usePresenceStore((s) => s.connection);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (connection === 'connected') requestMeeting(chatId);
  }, [chatId, connection]);
  const shown = isMeetingShown(meeting, folded);
  return (
    <div
      ref={body}
      className={meeting ? 'mm-body' : 'mm-contents'}
      data-testid={meeting ? 'meeting-body' : undefined}
      data-meeting-shown={shown ? 'true' : undefined}
    >
      {shown ? <MeetingPanel chatId={chatId} meeting={meeting} height={height} /> : null}
      {shown ? <ResizeBar body={body} height={height} /> : null}
      <div className={meeting ? 'mm-left' : 'mm-contents'}>
        {meeting && !shown ? <FoldedBar chatId={chatId} meeting={meeting} /> : null}
        {children}
      </div>
    </div>
  );
}

/** The bar between the meeting and the chat: drag it, or use the arrow keys, to share the height. */
function ResizeBar({
  body,
  height,
}: {
  body: React.RefObject<HTMLDivElement | null>;
  height: number;
}) {
  const setHeight = useMeetingStore((s) => s.setHeight);
  const at = (clientY: number) => {
    const r = body.current?.getBoundingClientRect();
    if (r && r.height > 0) setHeight((clientY - r.top) / r.height);
  };
  return (
    <div
      className="mm-resize"
      data-testid="meeting-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the meeting"
      aria-valuenow={Math.round(height * 100)}
      aria-valuemin={15}
      aria-valuemax={90}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => at(ev.clientY);
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') setHeight(height - 0.05);
        else if (e.key === 'ArrowDown') setHeight(height + 0.05);
        else return;
        e.preventDefault();
      }}
    />
  );
}
