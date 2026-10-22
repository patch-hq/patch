// SidebarSortMenu — the sidebar's sort control, a pill of its own directly
// above the chat list (spec/14 § Sidebar ordering). It used to sit at the
// bottom of the view dropdown, where changing the order meant opening a
// control that is about what the list shows, not how it is ordered.

import { useEffect, useRef, useState, type JSX } from 'react';
import { ChevronDown } from 'lucide-react';
import { useUiStore } from '../stores/uiStore.js';
import { CHAT_SORTS, type ChatSort, type GroupSort } from '../lib/chatGroups.js';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';

export function SidebarSortMenu(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const chatSort = useUiStore((s) => s.chatSort);
  const setChatSort = useUiStore((s) => s.setChatSort);
  const groupSort = useUiStore((s) => s.groupSort);
  const setGroupSort = useUiStore((s) => s.setGroupSort);

  useDismissOnClickOff(open, [menuRef, triggerRef], () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const label = CHAT_SORTS.find((o) => o.value === chatSort)?.label ?? chatSort;

  return (
    <div className="sidebar-view-menu sidebar-sort-menu" data-testid="sidebar-sort-menu">
      <button
        type="button"
        ref={triggerRef}
        className="sidebar-view-trigger"
        data-testid="sidebar-sort-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Sort chats by: ${label}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sidebar-view-trigger-label">{label}</span>
        <ChevronDown size={14} aria-hidden className="sidebar-view-caret" />
      </button>
      {open ? (
        <div
          className="sidebar-view-popup"
          data-testid="sidebar-sort-popup"
          role="listbox"
          aria-label="Sort"
          ref={menuRef}
        >
          <SortGroup id="chat-sort" title="Sort chats by" value={chatSort} onPick={setChatSort} />
          {chatSort === 'last-action' ? (
            <div className="sidebar-sort-note">Agent updates won’t move conversations</div>
          ) : null}
          <button
            type="button"
            className="sidebar-view-option sidebar-sort-advanced"
            data-testid="sidebar-sort-advanced"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            <span className="sidebar-view-option-label">Advanced</span>
            <span aria-hidden>{advancedOpen ? '▴' : '▾'}</span>
          </button>
          {advancedOpen ? <GroupSortGroup value={groupSort} onPick={setGroupSort} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function GroupSortGroup(props: { value: GroupSort; onPick(v: GroupSort): void }): JSX.Element {
  const options: ReadonlyArray<{ value: GroupSort; label: string }> = [
    { value: 'same-as-chats', label: 'Same as chats' },
    ...CHAT_SORTS,
  ];
  return (
    <div role="group" aria-label="Sort projects by" data-testid="sidebar-group-sort">
      <div className="sidebar-view-group-label">Sort projects by</div>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="option"
          aria-selected={opt.value === props.value}
          className={`sidebar-view-option ${opt.value === props.value ? 'selected' : ''}`}
          data-testid={`sidebar-group-sort-${opt.value}`}
          onClick={() => props.onPick(opt.value)}
        >
          <span className="sidebar-view-option-label">{opt.label}</span>
          {opt.value === props.value ? (
            <span className="sidebar-view-option-check" aria-hidden>
              ✓
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function SortGroup(props: {
  id: string;
  title: string;
  value: ChatSort;
  onPick(v: ChatSort): void;
}): JSX.Element {
  return (
    <div role="group" aria-label={props.title} data-testid={`sidebar-${props.id}`}>
      <div className="sidebar-view-group-label">{props.title}</div>
      {CHAT_SORTS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="option"
          aria-selected={opt.value === props.value}
          className={`sidebar-view-option ${opt.value === props.value ? 'selected' : ''}`}
          data-testid={`sidebar-${props.id}-${opt.value}`}
          onClick={() => props.onPick(opt.value)}
        >
          <span className="sidebar-view-option-label">{opt.label}</span>
          {opt.value === props.value ? (
            <span className="sidebar-view-option-check" aria-hidden>
              ✓
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
