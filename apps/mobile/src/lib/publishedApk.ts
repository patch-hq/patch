// The APK the paired server publishes, kept current for the whole app
// (spec/11 § Mobile updates): the install banner and Settings → Updates both
// read it, so they can never disagree about whether a new build needs installing.

import { AppState, type NativeEventSubscription } from 'react-native';
import { create } from 'zustand';
import { getRoute } from '../config';
import { fetchPublishedApk, type PublishedApk } from './updateCheck';

interface PublishedApkState {
  apk: PublishedApk | null;
  /** The last read's failure, verbatim. Cleared by the next good read. */
  error: string | null;
}

export const usePublishedApkStore = create<PublishedApkState>(() => ({ apk: null, error: null }));

/** Read what the server publishes now. Never rejects: a failure lands in `error`. */
export async function refreshPublishedApk(): Promise<void> {
  // Reached through the relay there is no address to download from; such a
  // phone hears of a new build from the install notification, which links the
  // release's own copy.
  if (getRoute()?.kind !== 'direct') return;
  try {
    usePublishedApkStore.setState({ apk: await fetchPublishedApk(), error: null });
  } catch (err) {
    usePublishedApkStore.setState({ error: (err as Error).message });
  }
}

const POLL_INTERVAL_MS = 30 * 60 * 1000;

/** Read now, every half hour, and whenever the app comes back to the front. */
export function startPublishedApkPolling(): () => void {
  void refreshPublishedApk();
  const timer = setInterval(() => void refreshPublishedApk(), POLL_INTERVAL_MS);
  let previous = AppState.currentState;
  const sub: NativeEventSubscription = AppState.addEventListener('change', (next) => {
    if (previous.match(/inactive|background/) && next === 'active') void refreshPublishedApk();
    previous = next;
  });
  return () => {
    clearInterval(timer);
    sub.remove();
  };
}
