// Meeting mode (right-hand panel + action cards above the composer). Pure view
// of the host's MeetingState; every control goes through lib/meetingControl.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_NOW_PROMPT,
  formatMeetingClock,
  meetingSpeakerLabel,
  meetingElapsedMs,
  MEETING_OWNER_EVERYONE,
  type MeetingAction,
  type MeetingState,
  type MeetingTopic,
} from '@patch/wire';
import {
  decideAction,
  setActionOwner,
  setAgentRunsActions,
  editMeetingNotes,
  saveMyNotes,
  endMeeting,
  getMeetingSpeed,
  listenHere,
  MEETING_SPEEDS,
  meetingSpeeds,
  setMeetingSpeed,
  pauseMeeting,
  requestMeeting,
  resumeMeeting,
} from '../lib/meetingControl.js';
import { useMeetingStore, type MeetingPromptKey } from '../stores/meetingStore.js';
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
function participantsOf(meeting: MeetingState): string[] {
  const names: string[] = [];
  for (const l of meeting.transcript) {
    if (l.speaker === 'them' && l.name === undefined) continue;
    const n = meetingSpeakerLabel(l);
    if (!names.includes(n)) names.push(n);
  }
  return names;
}

const TAP_PX = 4;
const MAX_DRAWER = 0.75;

/**
 * The transcript, with no box: closed it is the live line; open it is the
 * earlier lines with the latest at the bottom. The bar's bottom edge is the
 * divider — drag it to open, tap it to toggle between closed and half the window.
 */
function TranscriptDrawer({
  meeting,
  barRef,
}: {
  meeting: MeetingState;
  barRef: React.RefObject<HTMLElement | null>;
}) {
  const [height, setHeight] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  // Pinned to the latest line until Tom scrolls up; scrolling back down re-pins.
  const pinned = useRef(true);
  const open = height !== null;
  const last = meeting.transcript.at(-1);
  const speaker = last ? meetingSpeakerLabel(last) : null;
  const ended = meeting.status === 'ended';
  const liveText = meeting.live ?? last?.text ?? null;

  /** Tallest the drawer may be, so the whole bar stays within 75% of the window. */
  const maxHeight = () => {
    const bar = barRef.current;
    const box = scroller.current;
    const chrome = bar && box ? bar.offsetHeight - box.offsetHeight : 0;
    return Math.max(0, window.innerHeight * MAX_DRAWER - chrome);
  };
  const setOpen = (h: number | null) => {
    if (h !== null) pinned.current = true;
    setHeight(h);
  };
  const toggle = () => setOpen(open ? null : Math.round(window.innerHeight / 2));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: scroller.current?.offsetHeight ?? 0, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dy) < TAP_PX) return;
    d.moved = true;
    const next = Math.min(maxHeight(), Math.max(0, d.h + dy));
    setOpen(next < TAP_PX * 4 ? null : next);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) toggle();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [meeting.transcript, open]);

  return (
    <div className="mm-drawer" data-testid="meeting-drawer" data-open={open}>
      <div className="mm-label" data-testid="meeting-now-label">
        {ended ? 'Transcript' : speaker ? `Now · ${speaker}` : 'Now'}
      </div>
      {open ? (
        <div
          className="mm-lines"
          data-testid="meeting-lines"
          ref={scroller}
          style={{ height }}
          onScroll={onScroll}
        >
          {meeting.transcript.map((l, i) => (
            <div
              key={i}
              data-testid="meeting-line"
              className={i === meeting.transcript.length - 1 ? 'mm-ln newest' : 'mm-ln'}
            >
              <span className="tm">{formatMeetingClock(l.at)}</span>
              <span>
                <b>{meetingSpeakerLabel(l)}</b> {l.text}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mm-live" data-testid="meeting-live" ref={scroller}>
          {liveText !== null ? (
            <>
              {speaker ? <b>{speaker}</b> : null} {liveText}
            </>
          ) : ended ? null : (
            <span className="mm-wait">Listening…</span>
          )}
        </div>
      )}
      <div
        className="mm-grip"
        data-testid="meeting-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Transcript divider: drag or press to open"
        aria-expanded={open}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/** Bar across the top of the meeting: timer, people, controls, errors and the transcript drawer. */
export function MeetingBar({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const capturing = useMeetingStore((s) => s.capturingChatId === chatId);
  const now = useNow(meeting.status === 'live');
  const elapsed = meetingElapsedMs(meeting, now);
  const barRef = useRef<HTMLElement>(null);
  const people = participantsOf(meeting);

  return (
    <section className="mm-bar" data-testid="meeting-bar" data-status={meeting.status} ref={barRef}>
      <div className="mm-head">
        {meeting.status === 'ended' ? (
          <span className="mm-pill ended" data-testid="meeting-pill">
            Ended · {Math.max(1, Math.round(elapsed / 60_000))} min
          </span>
        ) : (
          <span className="mm-pill" data-testid="meeting-pill">
            {meeting.status === 'live' ? <span className="mm-dot" /> : null}
            {meeting.status === 'live' ? 'Live' : 'Paused'} · {formatMeetingClock(elapsed)}
          </span>
        )}
        {people.length > 0 ? (
          <span className="mm-people" data-testid="meeting-people" title={people.join(', ')}>
            {people.join(' · ')}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {meeting.status === 'live' ? (
          <button
            type="button"
            className="mm-btn"
            data-testid="meeting-pause"
            onClick={() => pauseMeeting(chatId)}
          >
            Pause
          </button>
        ) : null}
        {meeting.status === 'paused' ? (
          <button
            type="button"
            className="mm-btn"
            data-testid="meeting-resume"
            onClick={() => resumeMeeting(chatId)}
          >
            Resume
          </button>
        ) : null}
        {meeting.status !== 'ended' ? (
          <button
            type="button"
            className="mm-end"
            data-testid="meeting-end"
            onClick={() => endMeeting(chatId)}
          >
            End
          </button>
        ) : null}
      </div>

      {meeting.error ? (
        <div className="mm-error" role="alert" data-testid="meeting-error">
          {meeting.error}
        </div>
      ) : null}
      {meeting.status === 'live' && !capturing ? (
        <div className="mm-error" data-testid="meeting-not-listening">
          This device is not listening.{' '}
          <button
            type="button"
            className="mm-btn"
            data-testid="meeting-listen-here"
            onClick={() => void listenHere(chatId)}
          >
            Listen here
          </button>
        </div>
      ) : null}

      <TranscriptDrawer meeting={meeting} barRef={barRef} />
      {meeting.status === 'ended' ? (
        <div className="mm-now" data-testid="meeting-now">
          <div className="mm-label">Summary</div>
          {meeting.summary ? (
            <>
              <h4>{meeting.summary.headline}</h4>
              <ul>
                {meeting.summary.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </>
          ) : (
            <h4 className="mm-wait">No summary</h4>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** What the cog opens: the meeting's prompts, models and timing, in place. */
function MeetingSettingsPane({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const promptEditor = useMeetingStore((s) => s.promptEditor);
  const openPromptEditor = useMeetingStore((s) => s.openPromptEditor);
  return (
    <div className="mm-settings" data-testid="meeting-settings">
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

type PanelTab = 'points' | 'notes';

/** Newest point is level 0, then the next three, then older ones fade to a single line. */
function taperLevel(i: number): 0 | 1 | 2 | 3 {
  return i === 0 ? 0 : i <= 3 ? 1 : i <= 6 ? 2 : 3;
}

const MAX_LINES_BEHIND = 12;

/** The transcript lines a point came from: from its time up to the next newer point's. */
function linesBehind(meeting: MeetingState, t: MeetingTopic, newer: MeetingTopic | undefined) {
  const end = newer ? newer.at : Infinity;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  level,
  lines,
  focus,
  setFocus,
}: {
  chatId: string;
  topic: MeetingTopic;
  level: 0 | 1 | 2 | 3;
  lines: MeetingState['transcript'];
  focus: PointFocus | null;
  setFocus: (f: PointFocus | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const decision = DECISION.exec(t.title);
  const titleText = decision ? t.title.slice(decision[0].length) : t.title;
  const wants = (bullet: number | null) =>
    focus !== null && focus.topicId === t.id && focus.bullet === bullet;
  const edit = (e: Parameters<typeof editMeetingNotes>[1]) => editMeetingNotes(chatId, e);

  const commitTitle = (text: string) => {
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
      className={`mm-topic l${level}`}
      data-testid="meeting-topic"
      data-level={level}
      data-decided={decision ? 'true' : undefined}
    >
      <button
        type="button"
        className="mm-ins"
        data-testid="meeting-point-insert"
        aria-label="Add a point here"
        title="Add a point here"
        onClick={() => {
          const id = `pt_${Math.random().toString(36).slice(2, 10)}`;
          edit({ op: 'insert', aboveTopicId: t.id, id });
          setFocus({ topicId: id, bullet: null });
        }}
      >
        +
      </button>
      <div className="r">
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
        <span className="nm">
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
        </span>
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
              <b>{meetingSpeakerLabel(l)}</b> {l.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Free text Tom types; saved shortly after he stops, and adopted from other surfaces unless he is typing. */
function MyNotes({ chatId, saved }: { chatId: string; saved: string }) {
  const [text, setText] = useState(saved);
  const ref = useRef<HTMLTextAreaElement>(null);
  const sent = useRef(saved);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(text);
  latest.current = text;

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (latest.current === sent.current) return;
    sent.current = latest.current;
    saveMyNotes(chatId, latest.current);
  }, [chatId]);

  useEffect(() => {
    if (document.activeElement === ref.current) return;
    sent.current = saved;
    setText(saved);
  }, [saved]);
  useEffect(() => flush, [flush]);

  return (
    <textarea
      ref={ref}
      className="mm-mynotes"
      data-testid="meeting-my-notes"
      aria-label="My notes"
      placeholder="Type your own notes…"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        latest.current = e.target.value;
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, 600);
      }}
      onBlur={flush}
    />
  );
}

/** Right-hand panel: Points and My notes, with a cog for the meeting's settings. */
export function MeetingPanel({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const [tab, setTab] = useState<PanelTab>('points');
  const settingsOpen = useMeetingStore((s) => s.settingsOpen);
  const setSettingsOpen = useMeetingStore((s) => s.setSettingsOpen);
  const topics = useMemo(() => [...meeting.topics].sort((a, b) => b.at - a.at), [meeting.topics]);
  const [focus, setFocus] = useState<PointFocus | null>(null);

  return (
    <aside className="mm-panel" data-testid="meeting-panel" data-status={meeting.status}>
      <div className="mm-tabs" role="tablist">
        {(['points', 'notes'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            className="mm-tab"
            aria-selected={!settingsOpen && tab === t}
            data-testid={`meeting-tab-${t}`}
            onClick={() => {
              setTab(t);
              setSettingsOpen(false);
            }}
          >
            {t === 'points' ? 'Points' : 'My notes'}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="mm-cog"
          data-testid="meeting-cog"
          aria-label="Prompts, models and timing"
          title="Prompts, models and timing"
          aria-pressed={settingsOpen}
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </div>

      {settingsOpen ? (
        <MeetingSettingsPane chatId={chatId} meeting={meeting} />
      ) : tab === 'points' ? (
        <div className="mm-points" data-testid="meeting-points">
          {topics.length === 0 ? <div className="mm-wait">No points yet</div> : null}
          {topics.map((t, i) => (
            <PointRow
              key={t.id}
              chatId={chatId}
              topic={t}
              level={taperLevel(i)}
              lines={linesBehind(meeting, t, topics[i - 1])}
              focus={focus}
              setFocus={setFocus}
            />
          ))}
        </div>
      ) : (
        <MyNotes chatId={chatId} saved={meeting.myNotes ?? ''} />
      )}
    </aside>
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
}: {
  chatId: string;
  action: MeetingAction;
  speakers: string[];
  agentRuns: boolean;
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
      {action.kind === 'other' ? (
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
      ) : action.kind === 'agent' && !agentRuns ? (
        <button
          type="button"
          className="mm-act-btn"
          data-testid="meeting-action-do"
          onClick={() => decideAction(chatId, action.id, 'do')}
        >
          Run
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

/** The actions tray above the composer: Tom's, other people's, and the agent's. */
export function MeetingActions({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const [open, setOpen] = useState(true);
  const live = meeting.actions.filter((a) => a.status !== 'dismissed');
  if (live.length === 0) return null;
  const of = (k: MeetingAction['kind']) => live.filter((a) => a.kind === k);
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
    <div className="mm-tray" data-testid="meeting-actions">
      <div className="mm-tray-head">
        <button
          type="button"
          className="mm-tray-toggle"
          data-testid="meeting-actions-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="mm-tray-label">Actions</span>
          <span className="mm-tray-count" data-testid="meeting-actions-count">
            <b>{mine.length}</b> mine · <b>{others.length}</b> others · <b>{agent.length}</b> agent
          </span>
        </button>
        <input
          type="checkbox"
          data-testid="meeting-agent-runs"
          title="Agent runs its own actions"
          aria-label="Agent runs its own actions"
          checked={agentRuns}
          onChange={(e) => setAgentRunsActions(chatId, e.target.checked)}
        />
        <button
          type="button"
          className="mm-tray-caret"
          aria-label={open ? 'Collapse actions' : 'Expand actions'}
          onClick={() => setOpen(!open)}
        >
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open ? (
        <div className="mm-tray-body" data-testid="meeting-actions-body">
          {groups.map(([label, rows]) =>
            rows.length === 0 ? null : (
              <div key={label}>
                {ended ? <div className="mm-tray-grp">{label}</div> : null}
                {rows.map((a) => (
                  <ActionRow
                    key={a.id}
                    chatId={chatId}
                    action={a}
                    speakers={speakers}
                    agentRuns={agentRuns}
                  />
                ))}
              </div>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Wraps the chat's stream + composer. With a meeting it becomes a bar on top
 * and a two-column body with the panel on the right; without one it is `display: contents`, so
 * the wrapped tree never remounts when a meeting starts or ends.
 */
export function MeetingLayout({ chatId, children }: { chatId: string; children: ReactNode }) {
  const meeting = useMeetingStore((s) => s.byChat[chatId]);
  const connection = usePresenceStore((s) => s.connection);
  useEffect(() => {
    if (connection === 'connected') requestMeeting(chatId);
  }, [chatId, connection]);
  return (
    <div
      className={meeting ? 'mm-body' : 'mm-contents'}
      data-testid={meeting ? 'meeting-body' : undefined}
    >
      {meeting ? <MeetingBar chatId={chatId} meeting={meeting} /> : null}
      <div className={meeting ? 'mm-main' : 'mm-contents'}>
        <div className={meeting ? 'mm-left' : 'mm-contents'}>{children}</div>
        {meeting ? <MeetingPanel chatId={chatId} meeting={meeting} /> : null}
      </div>
    </div>
  );
}
