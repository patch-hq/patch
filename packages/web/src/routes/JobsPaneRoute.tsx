// JobsPaneRoute — bridges the URL to the pane/tab layout (spec/14 § Panes and
// tabs). Mounted at `/jobs`, same shape as `ChatPaneRoute`.

import { useEffect } from 'react';
import type { JSX } from 'react';
import { PaneArea } from '../components/PaneArea.js';
import { useRouteOpenTab } from '../lib/navigationOpen.js';
import type { PatchWs } from '../api/ws.js';

export function JobsPaneRoute({ ws }: { ws: PatchWs | null }): JSX.Element {
  const openTab = useRouteOpenTab();
  useEffect(() => {
    openTab({ kind: 'page', page: 'jobs' });
  }, [openTab]);
  return <PaneArea ws={ws} />;
}
