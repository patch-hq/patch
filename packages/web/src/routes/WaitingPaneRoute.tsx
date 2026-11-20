// WaitingPaneRoute — bridges /waiting to the pane/tab layout, same shape as `InboxPaneRoute`.

import { useEffect } from 'react';
import type { JSX } from 'react';
import { PaneArea } from '../components/PaneArea.js';
import { useRouteOpenTab } from '../lib/navigationOpen.js';
import type { PatchWs } from '../api/ws.js';

export function WaitingPaneRoute({ ws }: { ws: PatchWs | null }): JSX.Element {
  const openTab = useRouteOpenTab();
  useEffect(() => {
    openTab({ kind: 'page', page: 'waiting' });
  }, [openTab]);
  return <PaneArea ws={ws} />;
}
