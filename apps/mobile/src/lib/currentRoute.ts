// Where the app is, for handover (spec/05 § Handover).
//
// NOT expo-router's `usePathname` / `useGlobalSearchParams` /
// `useRootNavigationState` / `useSegments`: each calls `syncStoreRootState()`
// during render, which compares the store's root state with
// `navigationRef.getRootState()`. With a nested navigator (the tab group) that
// call returns a NEW object every time, so the store looks stale on every render
// and `useSyncExternalStore` re-renders forever — the JS thread pinned at 100%
// on every tab screen until the app ran out of memory. Reading the container
// ref and listening for its own events never touches the store.

import React from 'react';
import { useNavigationContainerRef } from 'expo-router';
import { pathFromRoute } from './viewPosition';

export interface CurrentRoute {
  /** The navigator has mounted: navigating is allowed. */
  ready: boolean;
  /** The focused screen's path; '' until there is one. */
  pathname: string;
  /** The focused screen's `id` param, when it has one. */
  id: string | undefined;
}

const NOT_READY: CurrentRoute = { ready: false, pathname: '', id: undefined };

type RouteRef = ReturnType<typeof useNavigationContainerRef>;

function read(ref: RouteRef): CurrentRoute {
  if (!ref.isReady()) return NOT_READY;
  const route = ref.getCurrentRoute();
  if (!route) return { ready: true, pathname: '', id: undefined };
  const params = route.params as Record<string, unknown> | undefined;
  const id = params?.id;
  return {
    ready: true,
    pathname: pathFromRoute(route.name, params),
    id: typeof id === 'string' ? id : undefined,
  };
}

export function useCurrentRoute(): CurrentRoute {
  const ref = useNavigationContainerRef();
  const [current, setCurrent] = React.useState<CurrentRoute>(() => read(ref));
  React.useEffect(() => {
    const update = (): void => {
      const next = read(ref);
      // Same place, same state: keep the object so nothing re-renders.
      setCurrent((prev) =>
        prev.ready === next.ready && prev.pathname === next.pathname && prev.id === next.id
          ? prev
          : next,
      );
    };
    update();
    const offState = ref.addListener('state', update);
    const offReady = ref.addListener('ready', update);
    return () => {
      offState();
      offReady();
    };
  }, [ref]);
  return current;
}
