// Meeting mode (right-hand panel + action cards above the composer). Pure view
// of the host's MeetingState; every control goes through lib/meetingControl.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_NOW_PROMPT,
  formatMeetingClock,
  meetingElapsedMs,
  meetingSpeakerLabel,
  type MeetingState,
} from '@patch/wire';
import {
  decideAction,
  endMeeting,
  getMeetingSpeed,
  listenHere,
  nameMeetingVoice,
  MEETING_SPEEDS,
  setMeetingSpeed,
  pauseMeeting,
  requestMeeting,
  resumeMeeting,
} from '../lib/meetingControl.js';
import { useMeetingStore, type MeetingPromptKey } from '../stores/meetingStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import type { AccountPreferences } from '../api/rest.js';
import { patchShared } from '../routes/settings/sharedWrite.js';
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
    ? Object.entries(MEETING_SPEEDS).find(
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

/** Bar across the top of the meeting: timer, controls, errors and Now. */
export function MeetingBar({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const capturing = useMeetingStore((s) => s.capturingChatId === chatId);
  const now = useNow(meeting.status === 'live');
  const elapsed = meetingElapsedMs(meeting, now);
  const card = meeting.status === 'ended' ? meeting.summary : meeting.now;

  return (
    <section className="mm-bar" data-testid="meeting-bar" data-status={meeting.status}>
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
        <span style={{ flex: 1 }} />
        {meeting.status !== 'ended' ? (
          <button
            type="button"
            className="mm-btn"
            data-testid="meeting-prompts"
            onClick={() => useMeetingStore.getState().openPromptEditor('notes')}
          >
            Prompts
          </button>
        ) : null}
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

      <PromptEditor />
      <div className="mm-now" data-testid="meeting-now">
        {meeting.status === 'ended' ? (
          <div className="mm-label">Summary</div>
        ) : (
          <PromptLabel prompt="now">Now</PromptLabel>
        )}
        {meeting.status !== 'ended' && meeting.live ? (
          <div className="mm-live" data-testid="meeting-live">
            {meeting.live}
          </div>
        ) : null}
        {card ? (
          <>
            <h4>{card.headline}</h4>
            <ul>
              {card.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
            {'who' in card && card.who !== '' ? (
              <div className="mm-who">{String(card.who)}</div>
            ) : null}
          </>
        ) : meeting.live ? null : (
          <h4 className="mm-wait">Listening…</h4>
        )}
      </div>
    </section>
  );
}

/** Right-hand panel: key points and the transcript in one scrolling column. */
export function MeetingPanel({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const [query, setQuery] = useState('');
  const topics = useMemo(() => [...meeting.topics].sort((a, b) => b.at - a.at), [meeting.topics]);
  const q = query.trim().toLowerCase();
  const lines = useMemo(
    () => meeting.transcript.filter((l) => q === '' || l.text.toLowerCase().includes(q)),
    [meeting.transcript, q],
  );
  const scroller = useRef<HTMLDivElement>(null);
  // Pinned to the latest line until Tom scrolls up; scrolling back down re-pins.
  const pinned = useRef(true);
  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <aside className="mm-panel" data-testid="meeting-panel" data-status={meeting.status}>
      {topics.length > 0 ? (
        <div className="mm-points" data-testid="meeting-points">
          <PromptLabel prompt="notes">Key points</PromptLabel>
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
      ) : null}

      <div className="mm-tx" data-testid="meeting-transcript">
        <div className="mm-label">Transcript</div>
        <input
          className="mm-search"
          data-testid="meeting-search"
          aria-label="Search transcript"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="ln" data-testid="meeting-lines" ref={scroller} onScroll={onScroll}>
          {lines.map((l, i) => (
            <div key={i} data-testid="meeting-line">
              <span>
                {formatMeetingClock(l.at)}{' '}
                {l.voice !== undefined ? (
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
                    {meetingSpeakerLabel(l, meeting.voices)}
                  </button>
                ) : (
                  meetingSpeakerLabel(l)
                )}
              </span>
              {l.text}
            </div>
          ))}
        </div>
      </div>
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
