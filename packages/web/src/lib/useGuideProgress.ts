// Live first-run progress, so the guide ticks off what the user has really done.
import { anyProviderConnected, usePreferencesStore } from '../stores/preferencesStore.js';
import { useChatStore } from '../stores/chatStore.js';
import type { GuideProgress } from './guide.js';

export function useGuideProgress(): GuideProgress {
  const connected = usePreferencesStore((s) => anyProviderConnected(s.shared)) === true;
  const hasChat = useChatStore((s) => Object.keys(s.chats).length > 0);
  return { connected, hasChat };
}
