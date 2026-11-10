// navigationOpen — how a route bridge opens its tab. A fresh navigation (link,
// sidebar click) may add a tab when the active one has unsaved edits (spec/14 §
// Opening things); browser/app Back and Forward (a POP) never do. When a POP
// cannot replace the active tab because it is dirty, say so rather than
// silently showing nothing.

import { useCallback } from 'react';
import { useNavigationType } from 'react-router-dom';
import { useLayoutStore, type OpenTabOptions, type TabDescriptor } from '../stores/layoutStore.js';
import { useUiStore } from '../stores/uiStore.js';

export const BACK_FORWARD_BLOCKED =
  'Back/Forward did not open this: the current tab has unsaved changes. Save or close it first.';

export function useRouteOpenTab(): (descriptor: TabDescriptor, opts?: OpenTabOptions) => void {
  const isPop = useNavigationType() === 'POP';
  return useCallback(
    (descriptor, opts = {}) => {
      const opened = useLayoutStore
        .getState()
        .openTab(descriptor, isPop ? { ...opts, replaceOnly: true } : opts);
      if (!opened) useUiStore.getState().pushError(BACK_FORWARD_BLOCKED);
    },
    [isPop],
  );
}
