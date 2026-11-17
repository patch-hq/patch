// TriagePaneRoute — bridges /triage to the pane/tab layout (spec/14 § Triage),
// same shape as `JobsPaneRoute`.

import { useEffect } from 'react';
import type { JSX } from 'react';
import { PaneArea } from '../components/PaneArea.js';
import { useRouteOpenTab } from '../lib/navigationOpen.js';
import type { PatchWs } from '../api/ws.js';

export function TriagePaneRoute({ ws }: { ws: PatchWs | null }): JSX.Element {
  const openTab = useRouteOpenTab();
  useEffect(() => {
    openTab({ kind: 'page', page: 'triage' });
  }, [openTab]);
  return <PaneArea ws={ws} />;
}
