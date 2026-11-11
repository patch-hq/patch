// GroupNumber — the small coloured number a sidebar row carries while its chat
// is showing in a group and more than one group is on screen (spec/14 §
// Groups). It matches the number and colour on the group's own card; clicking
// it focuses that group.

import type { JSX, MouseEvent as ReactMouseEvent } from 'react';
import { useLayoutStore } from '../stores/layoutStore.js';
import { groupColourClass } from './PaneArea.js';

/** Zero-based position of the group showing `chatId`, or null — also null
 *  while there is only one group, since a lone group needs no number. When
 *  several groups show the chat it is the one a click on the row would focus:
 *  the focused one, else the most recently used (spec/14 § Groups). */
export function useGroupIndex(chatId: string): number | null {
  return useLayoutStore((s) => {
    if (s.groups.length < 2) return null;
    let best = -1;
    s.groups.forEach((g, i) => {
      if (g.chatId !== chatId) return;
      if (g.id === s.focusedGroupId) best = i;
      else if (
        best === -1 ||
        (s.groups[best]!.id !== s.focusedGroupId && (g.usedAt ?? 0) > (s.groups[best]!.usedAt ?? 0))
      )
        best = i;
    });
    return best === -1 ? null : best;
  });
}

export function GroupNumber({ chatId }: { chatId: string }): JSX.Element | null {
  const index = useGroupIndex(chatId);
  const groupId = useLayoutStore((s) => (index === null ? null : s.groups[index]!.id));
  const focusGroup = useLayoutStore((s) => s.focusGroup);
  if (index === null || groupId === null) return null;
  return (
    <span
      className={`onscreen ${groupColourClass(index)}`}
      data-testid={`group-number-${chatId}`}
      role="button"
      aria-label={`Group ${index + 1}`}
      onClick={(e: ReactMouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        focusGroup(groupId);
      }}
    >
      {index + 1}
    </span>
  );
}
