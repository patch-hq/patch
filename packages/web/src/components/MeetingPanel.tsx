// Meeting mode (right-hand panel + action cards above the composer). Pure view
// of the host's MeetingState; every control goes through lib/meetingControl.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_NOW_PROMPT,
  formatMeetingClock,
  meetingSpeakerLabel,
  meetingElapsedMs,
  type MeetingState,
} from '@patch/wire';
import {
  decideAction,
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
} from '../lib/meetingControl.js';
import { useMeetingStore, type MeetingPromptKey } from '../stores/meetingStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import type { AccountPreferences } from '../api/rest.js';
import { patchShared } from '../routes/settings/sharedWrite.js';
import { MeetingModelRows } from '../routes/settings/PromptsPage.js';
import { Group } from '../routes/settings/ui.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import type { ReactNode } from 'react';

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

/** A section label that opens the in-call editor for that section's prompt. */
function PromptLabel({ prompt, children }: { prompt: MeetingPromptKey; children: ReactNode }) {
  const open = useMeetingStore((s) => s.openPromptEditor);
  return (
    <div className="mm-label">
      <button
        type="button"
        className="mm-label-btn"
        data-testid={`meeting-edit-${prompt}`}
        title={`Edit the ${PROMPT_FIELDS[prompt].title.toLowerCase()} prompt`}
        onClick={() => open(prompt)}
      >
        {children} ✎
      </button>
    </div>
  );
}

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
    const named = l.name !== undefined || meeting.voices?.[String(l.voice)] !== undefined;
    if (l.speaker === 'them' && !named) continue;
    const n = meetingSpeakerLabel(l, meeting.voices);
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
  chatId,
  meeting,
  barRef,
}: {
  chatId: string;
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
  const speaker = last ? meetingSpeakerLabel(last, meeting.voices) : null;
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
                {l.voice !== undefined && l.name === undefined ? (
                  <button
                    type="button"
                    className="mm-voice"
                    data-testid="meeting-voice"
                    onClick={() => {
                      const name = window.prompt(
                        'Who is this?',
                        meeting.voices?.[String(l.voice)] ?? '',
                      );
                      if (name && name.trim() !== '')
                        nameMeetingVoice(chatId, l.voice!, name.trim());
                    }}
                  >
                    <b>{meetingSpeakerLabel(l, meeting.voices)}</b>
                  </button>
                ) : (
                  <b>{meetingSpeakerLabel(l, meeting.voices)}</b>
                )}{' '}
                {l.text}
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
      {meeting.status === 'live' && meeting.echoDetected ? (
        <div className="mm-error" data-testid="meeting-echo-hint">
          The mic is picking up the call through your speakers. Use headphones to keep your voice
          separate from everyone else.
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

      <TranscriptDrawer chatId={chatId} meeting={meeting} barRef={barRef} />
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

/** Right-hand panel: Points and My notes, with a cog for the meeting's settings. */
export function MeetingPanel({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const [tab, setTab] = useState<PanelTab>('points');
  const settingsOpen = useMeetingStore((s) => s.settingsOpen);
  const setSettingsOpen = useMeetingStore((s) => s.setSettingsOpen);
  const topics = useMemo(() => [...meeting.topics].sort((a, b) => b.at - a.at), [meeting.topics]);

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
          {topics.map((t) => (
            <div className="mm-topic" key={t.id} data-testid="meeting-topic">
              <div className="r">
                <span className="tm">{formatMeetingClock(t.at)}</span>
                <span className="nm">{t.title}</span>
                {t.decided ? <span className="mm-dec">Decided</span> : null}
              </div>
              <ul>
                {t.points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <div className="mm-wait" data-testid="meeting-notes-tab">
          My notes is not built yet
        </div>
      )}
    </aside>
  );
}

export function MeetingActions({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const ordered = meeting.actions
    .filter((a) => a.status !== 'dismissed')
    .sort((a, b) => Number(a.status !== 'pending') - Number(b.status !== 'pending') || b.at - a.at);
  if (ordered.length === 0) return null;
  return (
    <div className="mm-actions" data-testid="meeting-actions">
      <div className="mm-actions-in">
        <PromptLabel prompt="actions">Actions</PromptLabel>
        {ordered.map((a) =>
          a.status === 'done' ? (
            <div
              className="mm-card done"
              key={a.id}
              data-testid="meeting-action"
              data-status="done"
            >
              <div className="w">
                <span className="tk">✓</span>
                {a.title}
              </div>
              <span className="y">
                {a.resolvedAt
                  ? new Date(a.resolvedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : ''}
              </span>
            </div>
          ) : (
            <div className="mm-card" key={a.id} data-testid="meeting-action" data-status="pending">
              <div className="w">
                <b>{a.title}</b>
                <div className="y">
                  {a.why} · {formatMeetingClock(a.at)}
                </div>
              </div>
              <button
                type="button"
                className="mm-do"
                data-testid="meeting-action-do"
                onClick={() => decideAction(chatId, a.id, 'do')}
              >
                Do it
              </button>
              <button
                type="button"
                className="mm-dis"
                data-testid="meeting-action-dismiss"
                onClick={() => decideAction(chatId, a.id, 'dismiss')}
              >
                Dismiss
              </button>
            </div>
          ),
        )}
      </div>
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
