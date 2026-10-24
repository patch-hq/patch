// TaskBar — the chat's task list at the top of the chat panel (spec/02 § Task
// list, spec/14 § Main chat panel). The list is the agent's own Claude Code
// TodoWrite list, mirrored onto chat state by the host; here it is also
// editable, because it is what the host fires the next turn from. Collapsed
// it is one line (current item + progress); expanded, the line is just a
// "Tasks" title (the items are listed below, so repeating one duplicates it) and every item's status,
// text and existence is the user's to change.
//
// Queueing: the add row writes into a local DRAFT, not the list. The agent is
// only told about (and the host only fires from) the list, so the user can type
// "x", "y", "z" and the agent looks once, when they press Done.
//
// Every edit sends the WHOLE list and is optimistic, reverting + surfacing a
// toast on failure (NO FALLBACK), matching the goal bar's pattern.

import { useEffect, useState, type JSX, type KeyboardEvent } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Paperclip,
  Plus,
  X,
} from 'lucide-react';
import type { TodoItem } from '@patch/wire';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useTaskDraftStore } from '../stores/taskDraftStore.js';
import { api } from '../api/rest.js';
import { InlineEditText } from './InlineEditText.js';
import type { ChatRow } from '../stores/types.js';
import { failed } from '../lib/errorCopy.js';

/** pending → in progress → done → pending, so one control covers the lifecycle. */
const NEXT_STATUS: Record<TodoItem['status'], TodoItem['status']> = {
  pending: 'in_progress',
  in_progress: 'completed',
  completed: 'pending',
};

const STATUS_LABEL: Record<TodoItem['status'], string> = {
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'done',
};

function StatusIcon({ status }: { status: TodoItem['status'] }): JSX.Element {
  if (status === 'completed') return <CircleCheck size={14} aria-hidden />;
  if (status === 'in_progress') return <CircleDot size={14} aria-hidden />;
  return <Circle size={14} aria-hidden />;
}

export function TaskBar({ row }: { row: ChatRow }): JSX.Element | null {
  const setTodos = useChatStore((s) => s.setTodos);
  const pushError = useUiStore((s) => s.pushError);
  const saved = useTaskDraftStore((s) => s.drafts[row.chatId]);
  const saveDraft = useTaskDraftStore((s) => s.set);
  // Unsent tasks survive a reload, so the bar reopens with them showing.
  const [expanded, setExpanded] = useState(saved !== undefined);
  const newTask = saved?.typed ?? '';
  const draft = saved?.queued ?? [];
  const setNewTask = (typed: string): void => saveDraft(row.chatId, { queued: draft, typed });
  const setDraft = (queued: string[]): void => saveDraft(row.chatId, { queued, typed: newTask });
  // A chat with no list shows no bar at all (spec/14): "Add tasks" lives in the
  // header's ⋯ menu, which summons the bar here with its add row open.
  const summoned = useUiStore((s) => s.taskAddChatId === row.chatId);
  const setTaskAddChatId = useUiStore((s) => s.setTaskAddChatId);
  useEffect(() => {
    if (summoned) setExpanded(true);
  }, [summoned]);

  const todos = row.todos;

  const done = todos.filter((t) => t.status === 'completed').length;
  // What the chat is on right now: the in-progress item, else the next pending
  // one. All done → say so rather than showing a stale last item.
  const head =
    todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status !== 'completed');

  async function commit(next: TodoItem[]): Promise<void> {
    const prev = todos;
    setTodos(row.chatId, next);
    try {
      await api.setTodos(row.chatId, next);
    } catch (err) {
      setTodos(row.chatId, prev);
      pushError(failed('updating tasks'), undefined, (err as Error).message);
    }
  }

  function cycle(index: number): void {
    const item = todos[index];
    if (!item) return;
    void commit(
      todos.map((t, i) => (i === index ? { ...t, status: NEXT_STATUS[item.status] } : t)),
    );
  }

  function rename(index: number, text: string): void {
    void commit(todos.map((t, i) => (i === index ? { ...t, text } : t)));
  }

  function remove(index: number): void {
    void commit(todos.filter((_, i) => i !== index));
  }

  function onNewTaskKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = newTask.trim();
    if (text === '') return;
    saveDraft(row.chatId, { queued: [...draft, text], typed: '' });
  }

  /** Hand the queued tasks to the agent: append them to the list in one write. */
  function release(): void {
    const typed = newTask.trim();
    const queued = typed === '' ? draft : [...draft, typed];
    if (queued.length === 0) return;
    saveDraft(row.chatId, { queued: [], typed: '' });
    void commit([...todos, ...queued.map((text) => ({ text, status: 'pending' as const }))]);
  }

  if (todos.length === 0 && !summoned && saved === undefined) return null;

  function toggle(): void {
    if (expanded && todos.length === 0 && saved === undefined) setTaskAddChatId(null);
    setExpanded(!expanded);
  }

  return (
    <div className="task-bar" data-testid="task-bar">
      <button
        type="button"
        className="task-bar-summary"
        data-testid="task-bar-summary"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse task list' : 'Expand task list'}
        onClick={toggle}
      >
        {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <span className="task-bar-head" data-testid="task-bar-head">
          {todos.length === 0
            ? 'Add tasks'
            : expanded
              ? 'Tasks'
              : head
                ? head.text
                : 'All tasks done'}
        </span>
        {draft.length > 0 ? (
          <span className="task-bar-count" data-testid="task-bar-queued">
            {draft.length} queued
          </span>
        ) : null}
        {todos.length > 0 ? (
          <span className="task-bar-count" data-testid="task-bar-count">
            {done}/{todos.length}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <ul className="task-bar-list" data-testid="task-bar-list">
          {todos.map((t, i) => (
            <li
              className={`task-row task-row-${t.status}`}
              data-testid="task-row"
              key={`${i}-${t.text}`}
            >
              <button
                type="button"
                className="task-status-btn"
                data-testid="task-status-btn"
                aria-label={`Task ${STATUS_LABEL[t.status]}, mark ${STATUS_LABEL[NEXT_STATUS[t.status]]}`}
                title={STATUS_LABEL[t.status]}
                onClick={() => cycle(i)}
              >
                <StatusIcon status={t.status} />
              </button>
              <InlineEditText
                className="task-text"
                testId="task-text"
                editLabel="Edit task"
                value={t.text}
                onCommit={(text) => rename(i, text)}
              />
              {t.attachments && t.attachments.length > 0 ? (
                <span className="task-attachments" data-testid="task-attachments">
                  {t.attachments.map((a) => (
                    <a
                      key={a.id}
                      className="task-attachment"
                      data-testid="task-attachment"
                      href={`/api/chats/${encodeURIComponent(row.chatId)}/attachment/${encodeURIComponent(a.id)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Paperclip size={12} aria-hidden />
                      {a.name}
                    </a>
                  ))}
                </span>
              ) : null}
              <button
                type="button"
                className="task-delete-btn"
                data-testid="task-delete-btn"
                aria-label="Delete task"
                title="Delete task"
                onClick={() => remove(i)}
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
          {draft.map((text, i) => (
            <li
              className="task-row task-row-draft"
              data-testid="task-draft-row"
              key={`draft-${i}-${text}`}
            >
              <span className="task-status-btn task-add-icon" aria-hidden>
                <Circle size={14} />
              </span>
              <span className="task-text">{text}</span>
              <button
                type="button"
                className="task-delete-btn"
                data-testid="task-draft-delete-btn"
                aria-label="Remove queued task"
                title="Remove queued task"
                onClick={() => setDraft(draft.filter((_, j) => j !== i))}
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
          <li className="task-row task-row-add">
            <span className="task-status-btn task-add-icon" aria-hidden>
              <Plus size={14} />
            </span>
            <input
              className="task-text task-add-input"
              data-testid="task-add-input"
              aria-label="Add task"
              placeholder="Add task"
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              onKeyDown={onNewTaskKeyDown}
            />
            {draft.length > 0 || newTask.trim() !== '' ? (
              <button
                type="button"
                className="task-done-btn"
                data-testid="task-draft-done"
                onClick={release}
              >
                Done
              </button>
            ) : null}
          </li>
        </ul>
      ) : null}
    </div>
  );
}
