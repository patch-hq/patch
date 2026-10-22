// ProjectSnoozeMenu — the folder header's "Snooze all" control (spec/04 §
// Snooze, spec/14 § Sidebar → Folders). Opens the Snooze sheet for the whole
// project: every chat `archiveAllInProject` would reach (`chatsInProject`:
// folder match, non-special, not archived or deleted), snoozed ones included.
import type { JSX } from 'react';
import { Clock } from 'lucide-react';
import { useUiStore } from '../stores/uiStore.js';

export function ProjectSnoozeMenu({
  folder,
  hostId,
  name,
}: {
  folder: string;
  hostId: string;
  name: string;
}): JSX.Element {
  const openSnoozeSheet = useUiStore((s) => s.openSnoozeSheet);
  return (
    <span className="snooze-wrap">
      <button
        type="button"
        className="folder-archive-btn"
        data-testid={`folder-snooze-${folder}`}
        title="Snooze all"
        aria-label={`snooze all in project ${name}`}
        onClick={() => openSnoozeSheet({ kind: 'project', folder, hostId, name })}
      >
        <Clock size={13} aria-hidden />
      </button>
    </span>
  );
}
