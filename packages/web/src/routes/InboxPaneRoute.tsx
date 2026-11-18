// InboxPaneRoute — bridges /inbox to the pane/tab layout, same shape as `TriagePaneRoute`.

import { useEffect } from 'react';
import type { JSX } from 'react';
import { PaneArea } from '../components/PaneArea.js';
import { useRouteOpenTab } from '../lib/navigationOpen.js';
import type { PatchWs } from '../api/ws.js';

export function InboxPaneRoute({ ws }: { ws: PatchWs | null }): JSX.Element {
  const openTab = useRouteOpenTab();
  useEffect(() => {
    openTab({ kind: 'page', page: 'inbox' });
  }, [openTab]);
  return <PaneArea ws={ws} />;
}
