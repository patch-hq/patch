// Live first-run progress, so the guide ticks off what the user has really done.
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { anyProviderConnected, usePreferencesStore } from '../stores/preferencesStore.js';
import { useChatStore, type ChatEventEntry } from '../stores/chatStore.js';
import { useAllAccountsLimit } from './accountLimits.js';
import type { GuideProgress } from './guide.js';

const SPECIAL = new Set<string>(Object.values(SPECIAL_THREAD_IDS));

/**
 * True once the user's own chat has had a reply. A chat that exists but has not
 * answered yet, and the built-in Manager thread, do not count.
 */
export function hasFirstReply(timelines: Record<string, ChatEventEntry[]>): boolean {
  return Object.entries(timelines).some(
    ([chatId, entries]) =>
      !SPECIAL.has(chatId) && entries.some((e) => e.kind === 'message' && e.role === 'assistant'),
  );
}

export function useGuideProgress(): GuideProgress {
  const connected = usePreferencesStore((s) => anyProviderConnected(s.shared)) === true;
  const hasChat = useChatStore((s) => hasFirstReply(s.timelines));
  const limited = useAllAccountsLimit();
  return { connected, limited, hasChat };
}
