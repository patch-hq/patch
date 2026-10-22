// Meeting mode: the chat stays a chat, and the meeting lives in a panel on its right. Pure view
// of the host's MeetingState; every control goes through lib/meetingControl.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, RotateCcw, SlidersHorizontal } from 'lucide-react';
import {
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_NOW_PROMPT,
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
  decideAction,
  setActionOwner,
  setAgentRunsActions,
  setMeetingResearch,
  editMeetingNotes,
  addNote,
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
  regenerateWriteup,
} from '../lib/meetingControl.js';
import { writeupBodyHtml, writeupFromBody, writeupText } from '../lib/meetingWriteup.js';
import {
  isMeetingShown,
  useMeetingStore,
  type MeetingPromptKey,
  type MeetingView,
} from '../stores/meetingStore.js';
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

const PROMPT_FIELDS: Record<
  MeetingPromptKey,
  { title: string; field: keyof AccountPreferences; fallback: string }
> = {
  now: { title: 'Now', field: 'meetingNowPrompt', fallback: DEFAULT_MEETING_NOW_PROMPT },
  notes: { title: 'Notes', field: 'meetingNotesPrompt', fallback: DEFAULT_MEETING_NOTES_PROMPT },
  actions: {
    title: 'Actions',
    field: 'meetingActionsPrompt',
    fallback: DEFAULT_MEETING_ACTIONS_PROMPT,
  },
};

/** Edits one of the three meeting prompts without leaving the meeting; applies from the next pass. */
function PromptEditor() {
  const key = useMeetingStore((s) => s.promptEditor);
  const open = useMeetingStore((s) => s.openPromptEditor);
  const prefs = usePreferencesStore((s) => s.preferences);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (key) setDraft(String(prefs[PROMPT_FIELDS[key].field]));
    // Reload the text only when switching prompt, not on every preference push mid-typing.
  }, [key]);
  if (!key) return null;
  const { title, field, fallback } = PROMPT_FIELDS[key];
  const save = (text: string) =>
    void patchShared(`${title.toLowerCase()} prompt`, { [field]: text }).then((ok) => {
      if (ok) open(null);
    });
  return (
    <div className="mm-prompt" data-testid="meeting-prompt-editor">
      <div className="mm-prompt-tabs">
        {(Object.keys(PROMPT_FIELDS) as MeetingPromptKey[]).map((k) => (
          <button
            key={k}
            type="button"
            className="mm-btn"
            aria-pressed={k === key}
            data-testid={`meeting-prompt-tab-${k}`}
            onClick={() => open(k)}
          >
            {PROMPT_FIELDS[k].title}
          </button>
        ))}
      </div>
      <textarea
        aria-label={`${title} prompt`}
        data-testid="meeting-prompt-text"
        rows={8}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="mm-prompt-actions">
        <button type="button" className="mm-btn" onClick={() => open(null)}>
          Cancel
        </button>
        <button
          type="button"
          className="mm-btn"
          data-testid="meeting-prompt-reset"
          onClick={() => save(fallback)}
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

const VIEWS: MeetingView[] = ['notes', 'mine', 'actions', 'transcript'];
const VIEW_LABEL: Record<MeetingView, string> = {
  notes: 'Notes',
  mine: 'My notes',
  actions: 'Actions',
  transcript: 'Transcript',
};

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

/** The panel's first row: timer, people, Pause/End or Resume, settings, and fold once ended. */
function MeetingHead({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const setFolded = useMeetingStore((s) => s.setFolded);
  const settingsOpen = useMeetingStore((s) => s.settingsOpen);
  const setSettingsOpen = useMeetingStore((s) => s.setSettingsOpen);
  const ended = meeting.status === 'ended';
  return (
    <div className="mm-head" data-testid="meeting-bar" data-status={meeting.status}>
      <MeetingPill meeting={meeting} />
      <People meeting={meeting} />
      {meeting.status === 'live' ? (
        <button
          type="button"
          className="mm-btn"
          data-testid="meeting-pause"
          onClick={() => pauseMeeting(chatId)}
        >
          Pause
        </button>
      ) : (
        <button
          type="button"
          className="mm-btn"
          data-testid="meeting-resume"
          onClick={() => (ended ? void resumeEndedMeeting(chatId) : resumeMeeting(chatId))}
        >
          Resume
        </button>
      )}
      {!ended ? (
        <button
          type="button"
          className="mm-end"
          data-testid="meeting-end"
          onClick={() => endMeeting(chatId)}
        >
          End
        </button>
      ) : null}
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
          className="mm-btn"
          data-testid="meeting-open-summary"
          onClick={() => show('notes')}
        >
          Notes
        </button>
        <button
          type="button"
          className="mm-btn"
          data-testid="meeting-open-transcript"
          onClick={() => show('transcript')}
        >
          Transcript
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

/** The meeting's on/off switches: research as it goes, and the agent running its own actions. */
export function MeetingSwitches({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const ended = meeting.status === 'ended';
  return (
    <div className="mm-switches">
      <label className="mm-switch">
        <input
          type="checkbox"
          data-testid="meeting-research-on"
          checked={meeting.researchOn === true}
          disabled={ended}
          onChange={(e) => setMeetingResearch(chatId, e.target.checked)}
        />
        Research as we go
      </label>
      {ended ? null : (
        <label className="mm-switch">
          <input
            type="checkbox"
            data-testid="meeting-agent-runs"
            checked={meeting.agentRunsActions === true}
            onChange={(e) => setAgentRunsActions(chatId, e.target.checked)}
          />
          Agent does its own actions
        </label>
      )}
    </div>
  );
}

/** What the settings button opens: the switches, the meeting's prompts, models and timing, in place. */
function MeetingSettingsPane({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const promptEditor = useMeetingStore((s) => s.promptEditor);
  const openPromptEditor = useMeetingStore((s) => s.openPromptEditor);
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
      {promptEditor ? (
        <PromptEditor />
      ) : (
        <div className="mm-prompt-tabs">
          {(Object.keys(PROMPT_FIELDS) as MeetingPromptKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className="mm-btn"
              data-testid={`meeting-prompt-open-${k}`}
              onClick={() => openPromptEditor(k)}
            >
              {PROMPT_FIELDS[k].title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const MAX_LINES_BEHIND = 12;

/** The transcript lines a point came from: from its time up to the next point's. */
function linesBehind(meeting: MeetingState, t: MeetingTopic, next: MeetingTopic | undefined) {
  const end = next ? next.at : Infinity;
  return meeting.transcript.filter((l) => l.at >= t.at && l.at < end).slice(0, MAX_LINES_BEHIND);
}

/** Which editable field should take the caret once it has rendered. */
interface PointFocus {
  topicId: string;
  /** `null` is the point's title; a number is a bullet. */
  bullet: number | null;
}

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

/** One point: time, "Speaker: main thrust", bullets. Every piece is edited in place. */
function PointRow({
  chatId,
  topic: t,
  isNow,
  lines,
  focus,
  setFocus,
}: {
  chatId: string;
  topic: MeetingTopic;
  /** The newest point while the meeting is live. */
  isNow: boolean;
  lines: MeetingState['transcript'];
  focus: PointFocus | null;
  setFocus: (f: PointFocus | null) => void;
}) {
  const [open, setOpen] = useState(false);
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

  return (
    <div
      className={isNow ? 'mm-topic now' : 'mm-topic'}
      data-testid="meeting-topic"
      data-now={isNow ? 'true' : undefined}
      data-decided={decision ? 'true' : undefined}
    >
      <button
        type="button"
        className="tm"
        data-testid="meeting-point-time"
        aria-expanded={open}
        title="Show what was said"
        onClick={() => setOpen(!open)}
      >
        {formatMeetingClock(t.at)}
      </button>
      <div className="c">
        <div className="nm">
          {isNow ? <span className="mm-now-tag">Now</span> : null}
          {decision ? <span className="decw">Decision:</span> : null}
          {decision ? ' ' : null}
          <Editable
            value={titleText}
            testid="meeting-point-title"
            label="Point"
            placeholder="Speaker: what they argued"
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
                    if (text === '') return (document.activeElement as HTMLElement | null)?.blur();
                    commitBullet(i, text);
                    edit({ op: 'add_bullet', topicId: t.id, index: i + 1 });
                    setFocus({ topicId: t.id, bullet: i + 1 });
                  }}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {open ? (
          <div className="mm-tx" data-testid="meeting-point-lines">
            {lines.length === 0 ? (
              <span className="mm-wait">No transcript for this point</span>
            ) : null}
            {lines.map((l, i) => (
              <div key={i} data-testid="meeting-point-line">
                <b>{speakerDisplay(l)}</b> {l.text}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One of Tom's own notes, in full ink at the time he wrote it; edited in place, emptied to remove. */
function NoteRow({ chatId, note }: { chatId: string; note: MeetingNote }) {
  return (
    <div className="mm-topic mine" data-testid="meeting-note">
      <span className="tm">{formatMeetingClock(note.at)}</span>
      <div className="c">
        <div className="nm">
          <Editable
            value={note.text}
            testid="meeting-note-text"
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
      </div>
    </div>
  );
}

/** How long the live tail reaches back: roughly the last minute of talk. */
const TAIL_MS = 60_000;

/** The last minute or so of talk that the notes have not taken in yet, the newest line provisional. */
function LiveTail({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const newestPoint = meeting.topics.reduce((m, t) => Math.max(m, t.at), -1);
  const last = meeting.transcript.at(-1);
  if (meeting.live == null || !last) return null;
  const from = Math.max(newestPoint + 1, last.at - TAIL_MS);
  const lines = meeting.transcript.filter((l) => l.at >= from);
  if (lines.length === 0) return null;
  return (
    <div className="mm-tail" data-testid="meeting-tail">
      <div className="mm-label">Not in the summary yet</div>
      {lines.map((l, i) => (
        <div
          key={i}
          data-testid="meeting-line"
          className={i === lines.length - 1 ? 'mm-ln prov' : 'mm-ln'}
        >
          <span className="tm">{formatMeetingClock(l.at)}</span>
          <span>
            <SpeakerName chatId={chatId} meeting={meeting} line={l} /> {l.text}
          </span>
        </div>
      ))}
    </div>
  );
}

/** One entry in Notes: a point, or a research card at the time it was raised. */
export type NotesItem =
  | { kind: 'point'; at: number; topic: MeetingTopic }
  | { kind: 'card'; at: number; card: MeetingCard };

/** Points and research cards together, oldest first, so the newest is at the bottom. */
export function notesItems(topics: MeetingTopic[], cards: MeetingCard[]): NotesItem[] {
  return [
    ...topics.map((t) => ({ kind: 'point' as const, at: t.at, topic: t })),
    ...cards.map((c) => ({ kind: 'card' as const, at: c.at, card: c })),
  ].sort((a, b) => a.at - b.at);
}

/**
 * Notes: the points and the agent's research, oldest first, then while live the
 * talk the points have not taken in yet. Once ended, the write-up heads it.
 */
function NotesStream({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const [focus, setFocus] = useState<PointFocus | null>(null);
  const live = meeting.status !== 'ended';
  const items = useMemo(
    () => notesItems(meeting.topics, meeting.cards ?? []),
    [meeting.topics, meeting.cards],
  );
  const points = items.flatMap((i) => (i.kind === 'point' ? [i.topic] : []));
  const newest = points.at(-1);
  // Live, the newest stays in view; once ended, the write-up at the top does.
  const scroller = usePinnedScroll([items, meeting.transcript.length], live);

  return (
    <div className="mm-scroll" data-testid="meeting-points" ref={scroller}>
      <div className="mm-col">
        {!live ? <WriteupView chatId={chatId} meeting={meeting} /> : null}
        {items.length === 0 && live ? <div className="mm-wait">Listening…</div> : null}
        {items.map((i) => {
          if (i.kind === 'card') return <ResearchCard key={i.card.id} card={i.card} />;
          const at = points.indexOf(i.topic);
          return (
            <PointRow
              key={i.topic.id}
              chatId={chatId}
              topic={i.topic}
              isNow={live && i.topic === newest}
              lines={linesBehind(meeting, i.topic, points[at + 1])}
              focus={focus}
              setFocus={setFocus}
            />
          );
        })}
        {live ? <LiveTail chatId={chatId} meeting={meeting} /> : null}
      </div>
    </div>
  );
}

/** My notes: Tom's own notes, each at the time he wrote it, and a box to write the next one. */
function MyNotesPane({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const notes = useMemo(() => parseMeetingNotes(meeting.myNotes ?? ''), [meeting.myNotes]);
  const [draft, setDraft] = useState('');
  const scroller = usePinnedScroll([notes.length]);
  const write = () => {
    const text = draft.trim();
    if (text === '') return;
    addNote(chatId, text);
    setDraft('');
  };
  return (
    <div className="mm-mine">
      <div className="mm-scroll" data-testid="meeting-my-notes" ref={scroller}>
        <div className="mm-col">
          {notes.length === 0 ? <div className="mm-wait">No notes yet</div> : null}
          {notes.map((n) => (
            <NoteRow key={`n${n.index}`} chatId={chatId} note={n} />
          ))}
        </div>
      </div>
      <textarea
        className="mm-write"
        data-testid="meeting-note-input"
        aria-label="Write a note"
        placeholder="Write a note…"
        rows={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            write();
          }
        }}
      />
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
          <span className="mm-label">Transcript</span>
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
 * The write-up that heads Notes once the meeting has ended: an editable
 * title, date and duration, Regenerate and Copy, and a body of short headings.
 * Tom's words are dark ink, generated text is softer, and names the clean-up
 * pass fixed are underlined with the original on hover.
 */
function WriteupView({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const w = meeting.writeup ?? null;
  const fixes = meeting.nameFixes ?? [];
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [waiting, setWaiting] = useState(false);
  const [copied, setCopied] = useState(false);
  const meta = `${new Date(meeting.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${Math.max(1, Math.round(meeting.elapsedBaseMs / 60_000))} min`;
  const html = useMemo(() => (w ? writeupBodyHtml(w, fixes) : ''), [w, fixes]);

  // A new write-up from the host ends the wait; so does a failure.
  useEffect(() => setWaiting(false), [meeting.writeup, meeting.writeupError]);
  // Draw the host's version unless Tom is typing in it.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body && !body.contains(document.activeElement) && body.innerHTML !== html)
      body.innerHTML = html;
    const title = titleRef.current;
    if (title && document.activeElement !== title && title.textContent !== (w?.title ?? ''))
      title.textContent = w?.title ?? '';
  }, [html, w]);

  const read = () =>
    writeupFromBody(
      titleRef.current?.textContent ?? '',
      bodyRef.current ?? document.createElement('div'),
    );
  const flush = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (w) saveWriteup(chatId, read());
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const later = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  };

  const failure = meeting.writeupError;
  return (
    <div className="mm-sum" data-testid="meeting-summary">
      <div className="mm-sum-head">
        {w ? (
          <h1
            ref={titleRef}
            data-testid="meeting-writeup-title"
            role="textbox"
            aria-label="Title"
            contentEditable="plaintext-only"
            suppressContentEditableWarning
            onInput={later}
            onBlur={flush}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <h1>Summary</h1>
        )}
        <span className="meta" data-testid="meeting-writeup-meta">
          {meta}
        </span>
        <button
          type="button"
          className="mm-icon"
          data-testid="meeting-regenerate"
          aria-label="Regenerate"
          title={waiting ? 'Writing…' : 'Regenerate'}
          disabled={waiting}
          onClick={() => {
            setWaiting(true);
            regenerateWriteup(chatId);
          }}
        >
          <RotateCcw size={16} aria-hidden="true" className={waiting ? 'mm-spin' : undefined} />
        </button>
        {w ? (
          <button
            type="button"
            className="mm-icon"
            data-testid="meeting-copy"
            aria-label="Copy"
            title={copied ? 'Copied' : 'Copy'}
            onClick={() =>
              void navigator.clipboard.writeText(writeupText(read(), meta)).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <Copy size={16} aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>
      {failure ? (
        <div className="mm-error" role="alert" data-testid="meeting-writeup-error">
          {failure}
        </div>
      ) : null}
      {w ? (
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
          onInput={later}
          onBlur={flush}
        />
      ) : failure ? null : (
        <div className="mm-wait" data-testid="meeting-writeup-wait">
          Writing the summary…
        </div>
      )}
    </div>
  );
}

/** The panel on the chat's right: header row, tabs, errors, then a tab or the settings. */
export function MeetingPanel({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const view = useMeetingStore((s) => s.view[chatId] ?? 'notes');
  const setView = useMeetingStore((s) => s.setView);
  const settingsOpen = useMeetingStore((s) => s.settingsOpen);
  const setSettingsOpen = useMeetingStore((s) => s.setSettingsOpen);
  const ended = meeting.status === 'ended';
  // A meeting that ends goes to Notes, where the write-up now heads the points.
  const wasEnded = useRef(ended);
  useEffect(() => {
    if (ended === wasEnded.current) return;
    wasEnded.current = ended;
    if (ended) setView(chatId, 'notes');
  }, [ended, chatId, setView]);
  const actionCount = openActions(meeting).length;
  return (
    <aside className="mm-panel" data-testid="meeting-panel" data-status={meeting.status}>
      <MeetingHead chatId={chatId} meeting={meeting} />
      <div className="mm-tabs" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            className="mm-tab"
            aria-selected={!settingsOpen && view === v}
            data-testid={`meeting-tab-${v}`}
            onClick={() => {
              setView(chatId, v);
              setSettingsOpen(false);
            }}
          >
            {VIEW_LABEL[v]}
            {v === 'actions' && actionCount > 0 ? <b className="mm-tab-n">{actionCount}</b> : null}
          </button>
        ))}
      </div>
      <MeetingAlerts chatId={chatId} meeting={meeting} />
      {settingsOpen ? (
        <div className="mm-scroll">
          <div className="mm-col">
            <MeetingSettingsPane chatId={chatId} meeting={meeting} />
          </div>
        </div>
      ) : view === 'mine' ? (
        <MyNotesPane chatId={chatId} meeting={meeting} />
      ) : view === 'actions' ? (
        <MeetingActions chatId={chatId} meeting={meeting} />
      ) : view === 'transcript' ? (
        <TranscriptList chatId={chatId} meeting={meeting} />
      ) : (
        <NotesStream chatId={chatId} meeting={meeting} />
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

function ResearchCard({ card }: { card: MeetingCard }) {
  return (
    <div className="mm-card" data-testid="meeting-card" data-kind={card.kind}>
      <div className="mm-card-h">
        <span className="mm-card-k" data-testid="meeting-card-kind">
          {CARD_LABEL[card.kind]}
        </span>
        <span className="mm-card-q" data-testid="meeting-card-title">
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
        <span className="mm-card-t">{formatMeetingClock(card.at)}</span>
      </div>
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

function ActionRow({
  chatId,
  action,
  speakers,
  agentRuns,
  ended,
}: {
  chatId: string;
  action: MeetingAction;
  speakers: string[];
  agentRuns: boolean;
  /** After the meeting: others' actions show the owner's name, and nothing but Tom's can be dismissed. */
  ended: boolean;
}) {
  const owners =
    action.owner && !speakers.includes(action.owner) ? [action.owner, ...speakers] : speakers;
  return (
    <div
      className="mm-act"
      data-testid="meeting-action"
      data-kind={action.kind}
      data-status={action.status}
    >
      <span className="mm-act-t" title={action.why !== '' ? action.why : undefined}>
        {action.title}
      </span>
      {action.kind === 'other' && ended ? (
        <span className="mm-act-owner-name" data-testid="meeting-action-owner-name">
          {action.owner}
        </span>
      ) : action.kind === 'other' ? (
        <select
          className="mm-act-owner"
          data-testid="meeting-action-owner"
          aria-label="Owner"
          value={action.owner}
          onChange={(e) => setActionOwner(chatId, action.id, e.target.value)}
        >
          {owners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : null}
      {action.chatId ? <ActionChatStatus chatId={action.chatId} /> : null}
      {action.chatId ? (
        <Link
          className="mm-act-btn"
          data-testid="meeting-action-open"
          to={`/chats/${action.chatId}`}
        >
          Open chat
        </Link>
      ) : action.kind === 'mine' ? (
        <button
          type="button"
          className="mm-act-btn"
          data-testid="meeting-action-chat"
          onClick={() => decideAction(chatId, action.id, 'chat')}
        >
          Start chat
        </button>
      ) : action.kind === 'agent' && !agentRuns && !ended ? (
        <button
          type="button"
          className="mm-act-btn"
          data-testid="meeting-action-do"
          onClick={() => decideAction(chatId, action.id, 'do')}
        >
          Run
        </button>
      ) : null}
      {ended && action.kind !== 'mine' ? null : (
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
      )}
    </div>
  );
}

/** The Actions tab: Tom's, other people's and the agent's, one compact row each. */
export function MeetingActions({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const open = openActions(meeting);
  const of = (k: MeetingAction['kind']) => open.filter((a) => a.kind === k);
  const mine = of('mine');
  const others = of('other');
  const agent = of('agent');
  const speakers = [
    ...new Set(meeting.transcript.flatMap((l) => (l.speaker === 'them' && l.name ? [l.name] : []))),
    MEETING_OWNER_EVERYONE,
  ];
  const agentRuns = meeting.agentRunsActions === true;
  const ended = meeting.status === 'ended';
  const groups: Array<[string, MeetingAction[]]> = ended
    ? [
        ['Agent did', agent],
        ['My actions', mine],
        ['Other actions', others],
      ]
    : [
        ['Mine', mine],
        ['Others', others],
        ['Agent', agent],
      ];
  return (
    <div className="mm-scroll">
      <div className="mm-col mm-actions" data-testid="meeting-actions">
        {open.length === 0 ? <div className="mm-wait">No actions yet</div> : null}
        {groups.map(([label, rows]) =>
          rows.length === 0 ? null : (
            <div key={label}>
              <div className="mm-act-grp">{label}</div>
              {rows.map((a) => (
                <ActionRow
                  key={a.id}
                  chatId={chatId}
                  action={a}
                  speakers={speakers}
                  agentRuns={agentRuns}
                  ended={ended}
                />
              ))}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * Wraps the chat's stream + composer. With a meeting shown the chat stays as it
 * is on the left and the meeting's panel sits on its right; an ended meeting
 * folded away is one line over the chat. Without one it is `display: contents`,
 * and the nesting never changes, so the wrapped tree never remounts when a
 * meeting starts, ends or folds.
 */
export function MeetingLayout({ chatId, children }: { chatId: string; children: ReactNode }) {
  const meeting = useMeetingStore((s) => s.byChat[chatId]);
  const folded = useMeetingStore((s) => s.folded[chatId] === true);
  const connection = usePresenceStore((s) => s.connection);
  useEffect(() => {
    if (connection === 'connected') requestMeeting(chatId);
  }, [chatId, connection]);
  const shown = isMeetingShown(meeting, folded);
  return (
    <div
      className={meeting ? 'mm-body' : 'mm-contents'}
      data-testid={meeting ? 'meeting-body' : undefined}
      data-meeting-shown={shown ? 'true' : undefined}
    >
      <div className={meeting ? 'mm-left' : 'mm-contents'}>
        {meeting && !shown ? <FoldedBar chatId={chatId} meeting={meeting} /> : null}
        {children}
      </div>
      {shown ? <MeetingPanel chatId={chatId} meeting={meeting} /> : null}
    </div>
  );
}
