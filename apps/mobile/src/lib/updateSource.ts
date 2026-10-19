// Where this phone's over-the-air updates come from (spec/11 § Mobile updates):
// the server it is paired to, which mirrors the release it follows.
//
// The APK has no server address built in — pairing supplies it — so the address
// is handed to expo-updates at runtime (`setUpdateURLAndRequestHeadersOverride`).
// expo-updates reads that override when the app STARTS, so a change takes effect
// at the next launch, and until then this launch is still using the build-time
// URL, which nothing should contact. The answer is recorded here with the
// address it was set for: a launch whose override was already this address
// before it started is "active", and only then may anything check for updates.

import * as Updates from 'expo-updates';
import { getRoute } from '../config';
import { store } from './credential';

const SOURCE_KEY = 'patch.updates.source';
export const UPDATE_PATH = '/api/mobile/updates';

export type UpdateSource =
  /** Development or Expo Go: updates are off. */
  | { state: 'disabled' }
  /** Not paired yet, so there is no server to ask. */
  | { state: 'unpaired' }
  /**
   * Reached through the relay: native code has no relay connection, so it can
   * reach the server for nothing. This phone moves on by installing APKs.
   */
  | { state: 'relayed' }
  /** Set for this server, effective from the next launch. */
  | { state: 'pending'; url: string }
  /** This launch is checking this server. */
  | { state: 'active'; url: string };

let current: UpdateSource | null = null;

/**
 * Point updates at the paired server. Called at every launch and after pairing;
 * returns — and remembers for `updateSource()` — what that means for THIS launch.
 */
export function pointUpdatesAtServer(): UpdateSource {
  current = decide();
  return current;
}

function decide(): UpdateSource {
  if (__DEV__ || !Updates.isEnabled) return { state: 'disabled' };
  const route = getRoute();
  if (route === null) return { state: 'unpaired' };
  if (route.kind !== 'direct') return { state: 'relayed' };
  const url = `${route.url.replace(/\/$/, '')}${UPDATE_PATH}`;
  // Active only if the override was this address before this launch began —
  // which is what expo-updates read when it started. Recorded after setting,
  // so a crash between the two at worst costs one more restart.
  const before = store().getString(SOURCE_KEY);
  Updates.setUpdateURLAndRequestHeadersOverride({ updateUrl: url, requestHeaders: {} });
  store().set(SOURCE_KEY, url);
  return before === url ? { state: 'active', url } : { state: 'pending', url };
}

/** What `pointUpdatesAtServer` decided for this launch. */
export function updateSource(): UpdateSource {
  return current ?? pointUpdatesAtServer();
}

/** Why there is no update check right now, in a sentence, or null when there is one. */
export function updateSourceProblem(source: UpdateSource = updateSource()): string | null {
  switch (source.state) {
    case 'active':
      return null;
    case 'disabled':
      return 'Updates are off in development.';
    case 'unpaired':
      return 'This phone is not paired to a server yet.';
    case 'relayed':
      return 'Reached through the relay, this phone takes updates by installing new builds.';
    case 'pending':
      return 'Updates from this server start at the next launch. Restart the app.';
  }
}
