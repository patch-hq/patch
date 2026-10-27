// SidebarSortMenu — the sidebar's sort control, an always-visible segmented
// switch directly above the chat list (spec/14 § Sidebar ordering). It used to
// be a dropdown pill with project ordering folded under "Advanced", so the
// current order and the alternatives were both out of sight. Project ordering
// now lives in Settings → Chats.

import type { JSX } from 'react';
import { useUiStore } from '../stores/uiStore.js';
import { CHAT_SORTS } from '../lib/chatGroups.js';

export function SidebarSortMenu(): JSX.Element {
  const chatSort = useUiStore((s) => s.chatSort);
  const setChatSort = useUiStore((s) => s.setChatSort);
  return (
    <div
      className="sidebar-sort-seg"
      role="radiogroup"
      aria-label="Sort chats by"
      data-testid="sidebar-sort-menu"
    >
      {CHAT_SORTS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={opt.value === chatSort}
          aria-label={opt.label}
          title={opt.label}
          className={opt.value === chatSort ? 'on' : ''}
          data-testid={`sidebar-chat-sort-${opt.value}`}
          onClick={() => setChatSort(opt.value)}
        >
          {opt.short}
        </button>
      ))}
    </div>
  );
}
