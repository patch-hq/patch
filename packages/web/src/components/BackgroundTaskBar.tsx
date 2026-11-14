// BackgroundTaskBar — this chat's still-running `patch_watch` tasks, above the
// transcript (spec/14 § Main chat panel — Background task bar).
//
// A watched command keeps running after the turn that launched it ends, so a
// chat can read as idle with work still in flight. This is the standing
// readout: ONE BAR PER TASK, newest first, each spinning while it runs. The
// stack folds back to a single summary line on demand, and the fold persists
// (uiStore). Nothing to show when nothing of this chat's is running.
//
// Data comes from `GET /api/chats/:id/watch` (real fields off the host's
// persisted watch record: command, description, status, startedAt), not
// scraped from the transcript — the old Bash/Task `run_in_background`
// mechanism this replaced could never support a kill button (no real pid to
// signal), which is exactly why patch_watch exists (sdkBackend.ts's
// `canUseTool` deny).
//
// Drawn through the shared StatusRow (spec/14 § Main chat panel — Status
// list). One running task is one row; more than one fold into a single
// "Tasks" row whose pill opens one child row per task. The user can act on a
// row: ✕ kills the task, and clicking the row tails its output in the terminal.
//
// A task that has ENDED is not counted and not listed unless the "show ended"
// link is on: a bar that keeps a finished task reads as work that is stuck,
// which is the one thing this readout must never say by accident.

import { Fragment, useEffect, useRef, useState, type JSX } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import type { WatchTaskRow } from '@patch/wire';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useTerminalStore } from '../stores/terminalStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import {
  formatElapsed,
  runningWatchTasks,
  sortWatchTasks,
  watchTailCommand,
} from '../lib/backgroundTasks.js';
import { StatusPill, StatusRow } from './StatusRow.js';

/**
 * The turning glyph. It carries a class rather than lucide's own
 * `lucide-loader`, because the animation is this bar's and not every loader
 * icon in the app.
 *
 * A smooth ring rather than a spoked wheel: spokes make every frame of the
 * rotation legible, so the glyph strobes instead of turning, and a strobe over
 * the transcript pulls the eye off what it is sitting above.
 */
function Spinner(): JSX.Element {
  return <LoaderCircle className="status-spinner" size={16} aria-hidden />;
}

/**
 * How often the list is re-polled while the bar is on screen. Gated on the
 * chat's own LIVE running count (`chat.state.backgroundTasks`, updated the
 * instant a watch starts or is killed — chatRunner.ts's `emitState` calls in
 * `startWatch`/`stopWatch`), so nothing is polled for a chat with nothing
 * running: the live count is the source of truth for whether the bar exists
 * at all, and this poll only refines what is drawn inside it.
 */
const LIST_POLL_MS = 3_000;

/** How often running rows recompute their elapsed-time clock. */
const CLOCK_TICK_MS = 1_000;

/** Local HH:MM for a check-in time. */
function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** The task's last output line. Quiet is normal for a waiter, so silence is never flagged. */
function ProgressLine({ task }: { task: WatchTaskRow }): JSX.Element | null {
  if (task.lastLine === undefined) return null;
  return (
    <span
      className="status-muted status-grow"
      data-testid="background-task-bar-progress"
      title={task.lastLine}
    >
      {`· ${task.lastLine}`}
    </span>
  );
}

function useWatchTasks(chatId: string, enabled: boolean): WatchTaskRow[] {
  const [tasks, setTasks] = useState<WatchTaskRow[]>([]);

  useEffect(() => {
    if (!enabled) {
      setTasks([]);
      return;
    }
    let live = true;
    const load = async (): Promise<void> => {
      if (document.hidden) return;
      try {
        const res = await api.watchList(chatId);
        if (live) setTasks(res.tasks);
      } catch {
        // A failed poll keeps the last-known rows rather than blanking the
        // bar out from under a task that is, for all the caller knows, still
        // running fine — the live count (not this list) is what decides
        // whether the bar exists at all.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), LIST_POLL_MS);
    const onVisibility = (): void => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [chatId, enabled]);

  return tasks;
}

export function BackgroundTaskBar({ chatId }: { chatId: string }): JSX.Element | null {
  const liveCount = useChatStore((s) => s.chats[chatId]?.backgroundTasks ?? 0);
  const collapsed = useUiStore((s) => s.backgroundTasksCollapsed);
  const setCollapsed = useUiStore((s) => s.setBackgroundTasksCollapsed);
  const showAll = useUiStore((s) => s.backgroundTasksShowAll);
  const setShowAll = useUiStore((s) => s.setBackgroundTasksShowAll);
  const queuePending = useTerminalStore((s) => s.queuePending);
  const [killing, setKilling] = useState<Set<string>>(new Set());
  const [editingCheckIn, setEditingCheckIn] = useState<string | null>(null);
  const [checkInMinutes, setCheckInMinutes] = useState('60');

  const [now, setNow] = useState(() => Date.now());

  // The bar exists at all only while the chat has something running — the
  // live count is authoritative and moves the instant a watch starts or is
  // killed, unlike the polled list below (which only refines what is drawn).
  const hasWork = liveCount > 0;
  const tasks = useWatchTasks(chatId, hasWork);

  const anyRunning = tasks.some((t) => t.status === 'running');
  const ticking = anyRunning;
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [ticking]);

  /**
   * Show what a task is doing: a terminal tab for this chat (spec/14 § Panes
   * and tabs), tailed on the watch's own output file — named exactly by its
   * record, never guessed.
   */
  function showTask(task: WatchTaskRow): void {
    queuePending(chatId, { kind: 'command', text: watchTailCommand(task.outputFile) });
    useLayoutStore.getState().openTab({ kind: 'terminal', chatId });
  }

  async function killTask(task: WatchTaskRow): Promise<void> {
    setKilling((prev) => new Set(prev).add(task.taskId));
    try {
      await api.watchStop(chatId, task.taskId);
    } finally {
      setKilling((prev) => {
        const next = new Set(prev);
        next.delete(task.taskId);
        return next;
      });
      // The host's own `emitState` already moved the live count; this just
      // refreshes the row list (status/endedAt) without waiting out the poll.
      try {
        const res = await api.watchList(chatId);
        setTasksOverride(res.tasks);
      } catch {
        // Next poll tick will catch up.
      }
    }
  }

  // A ref-backed override lets `killTask` push a fresh list immediately
  // without re-deriving `useWatchTasks`'s own effect.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [override, setOverride] = useState<WatchTaskRow[] | null>(null);
  function setTasksOverride(next: WatchTaskRow[]): void {
    setOverride(next);
  }
  const effectiveTasks = override ?? tasks;
  useEffect(() => {
    setOverride(null);
  }, [tasks]);

  function openCheckInEditor(task: WatchTaskRow): void {
    const current =
      task.checkInSec ?? Math.max(60, Math.round(((task.nextCheckInAt ?? 0) - now) / 60_000) * 60);
    setCheckInMinutes(String(Math.max(1, Math.round(current / 60))));
    setEditingCheckIn(task.taskId);
  }

  async function saveCheckIn(task: WatchTaskRow): Promise<void> {
    const minutes = Number(checkInMinutes);
    if (!Number.isInteger(minutes) || minutes < 1) return;
    await api.watchCheckIn(chatId, task.taskId, minutes * 60);
    setEditingCheckIn(null);
    const res = await api.watchList(chatId);
    setTasksOverride(res.tasks);
  }

  if (!hasWork) return null;

  const running = runningWatchTasks(effectiveTasks);
  const shown = showAll ? sortWatchTasks(effectiveTasks) : running;
  // `liveCount` also counts running `patch_delegate` subagents (the sidebar
  // badge wants them), but this bar lists only watch tasks — agents have their
  // own strip. So the bar's own count and grouping come from its running rows,
  // never from `liveCount`, or it claims tasks it has no row for.
  if (running.length === 0) return null;
  const grouped = running.length > 1 || shown.length > 1;
  const open = !collapsed;
  const oldestStart = running.reduce<number | null>(
    (min, t) => (min === null || t.startedAt < min ? t.startedAt : min),
    null,
  );

  function taskRow(task: WatchTaskRow, nested: boolean): JSX.Element {
    const ended = task.status !== 'running';
    const label = ended
      ? `Show what "${task.description}" did in the terminal`
      : `Show what "${task.description}" is doing in the terminal`;
    return (
      <Fragment key={task.taskId}>
        <StatusRow
          nested={nested}
          icon={ended || nested ? null : <Spinner />}
          label={nested ? undefined : 'Task'}
          className={`${ended ? 'status-row-ended' : ''} ${nested ? '' : 'status-row-solo'}`}
          testId="background-task-bar-task"
          data-ended={ended ? 'true' : 'false'}
          onActivate={() => showTask(task)}
          activateLabel={label}
          meta={
            ended ? null : (
              <>
                {task.nextCheckInAt === undefined ? null : (
                  <span
                    className="status-checkin"
                    data-testid="background-task-bar-checkin"
                    role="button"
                    tabIndex={0}
                    title="Check-in interval"
                    onClick={(e) => {
                      e.stopPropagation();
                      openCheckInEditor(task);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      e.stopPropagation();
                      openCheckInEditor(task);
                    }}
                  >
                    {`check-in ${formatClock(task.nextCheckInAt)} · `}
                  </span>
                )}
                <span data-testid="background-task-bar-elapsed">
                  {formatElapsed(task.startedAt, now)}
                </span>
              </>
            )
          }
          action={
            ended ? null : (
              // A plain span, not a nested `<button>`: the row is itself a
              // button, and interactive content inside interactive content is
              // invalid HTML.
              <span
                data-testid="background-task-bar-kill"
                role="button"
                tabIndex={0}
                aria-label={`Kill "${task.description}"`}
                title={`Kill "${task.description}"`}
                aria-disabled={killing.has(task.taskId)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (killing.has(task.taskId)) return;
                  void killTask(task);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (killing.has(task.taskId)) return;
                  void killTask(task);
                }}
              >
                <X size={14} aria-hidden />
              </span>
            )
          }
        >
          <span className="status-grow" data-testid="background-task-bar-description">
            {task.description}
          </span>
          {task.killed ? (
            <span className="status-killed" data-testid="background-task-bar-killed">
              killed
            </span>
          ) : null}
          {ended ? null : <ProgressLine task={task} />}
        </StatusRow>
        {editingCheckIn === task.taskId ? (
          <StatusRow nested>
            <form
              data-testid="background-task-bar-checkin-form"
              className="status-checkin-form"
              onSubmit={(e) => {
                e.preventDefault();
                void saveCheckIn(task);
              }}
            >
              <span>Check in every</span>
              <input
                type="number"
                min={1}
                step={1}
                value={checkInMinutes}
                onChange={(e) => setCheckInMinutes(e.target.value)}
                data-testid="background-task-bar-checkin-input"
                aria-label="Check-in interval in minutes"
              />
              <span>min</span>
              <button type="submit" data-testid="background-task-bar-checkin-save">
                Set
              </button>
            </form>
          </StatusRow>
        ) : null}
      </Fragment>
    );
  }

  if (!grouped) {
    const only = shown[0];
    return only ? (
      <div data-testid="background-task-bar" role="status">
        {taskRow(only, false)}
      </div>
    ) : null;
  }

  const summary = `${running.length} running`;
  return (
    <div data-testid="background-task-bar" data-collapsed={open ? 'false' : 'true'} role="status">
      <StatusRow
        icon={<Spinner />}
        label="Tasks"
        meta={oldestStart === null ? null : formatElapsed(oldestStart, now)}
      >
        <StatusPill
          open={open}
          onToggle={() => setCollapsed(open)}
          testId="background-task-bar-toggle"
          label={open ? `Collapse ${summary}` : `Expand ${summary}`}
        >
          <span data-testid="background-task-bar-count">{summary}</span>
        </StatusPill>
        {open ? (
          <button
            type="button"
            className="status-link status-link-underline status-muted"
            data-testid="background-task-bar-show-all"
            aria-pressed={showAll}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? 'hide ended' : 'show ended'}
          </button>
        ) : (
          <span className="status-grow status-names">
            {running.map((t) => t.description).join(', ')}
          </span>
        )}
      </StatusRow>
      {open ? shown.map((task) => taskRow(task, true)) : null}
    </div>
  );
}
