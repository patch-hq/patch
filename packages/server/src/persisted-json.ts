import { canonicalizeHostNames } from '@patch/wire';

/**
 * JSON.parse for a file the server wrote on disk. Files written before the host
 * rename carry `daemonId` keys; they are read as `hostId`. Phase 3b replaces
 * this with a one-off rewrite of the data directory and deletes it.
 */
export function parsePersisted(text: string): unknown {
  return canonicalizeHostNames(JSON.parse(text));
}
