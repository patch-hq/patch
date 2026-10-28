// GroupNumber — the small coloured number a sidebar row carries while its chat
// is showing in a group and more than one group is on screen (spec/14 §
// Groups). It matches the number and colour on the group's own card; clicking
// it focuses that group.

import type { JSX, MouseEvent as ReactMouseEvent } from 'react';
import { useLayoutStore } from '../stores/layoutStore.js';
import { groupColourClass } from './PaneArea.js';

/** Zero-based position of the group showing `chatId`, or null — also null
 *  while there is only one group, since a lone group needs no number. */
export function useGroupIndex(chatId: string): number | null {
  return useLayoutStore((s) => {
    if (s.groups.length < 2) return null;
    const i = s.groups.findIndex((g) => g.chatId === chatId);
    return i === -1 ? null : i;
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
