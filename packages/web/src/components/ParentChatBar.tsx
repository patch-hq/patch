// ParentChatBar — the banner under the header of a chat that another chat
// launched with `patch_spawn`, opening that chat. The sibling of JobBar, which
// does the same for a chat a job launched.
//
// `parentChatId` arrives on `chat.spawned` and never changes. Chats no other
// chat launched have no bar.

import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquareShare, X } from 'lucide-react';
import { OpenableButton } from './OpenableLink.js';
import { useChatStore } from '../stores/chatStore.js';

// Chats whose bar the user dismissed, for the life of the page.
const dismissed = new Set<string>();

export function ParentChatBar({
  chatId,
  parentChatId,
}: {
  chatId: string;
  parentChatId: string;
}): JSX.Element | null {
  const navigate = useNavigate();
  const [hidden, setHidden] = useState(dismissed.has(chatId));
  const parentName = useChatStore((s) => s.chats[parentChatId]?.name ?? null);
  if (hidden) return null;
  return (
    <div className="archived-banner" data-testid="parent-chat-bar" role="status">
      <span className="archived-banner-label">
        <MessageSquareShare size={14} aria-hidden />
        {parentName !== null ? `Started by "${parentName}" chat` : 'Started by another chat'}
      </span>
      <OpenableButton
        opens={{ kind: 'chat', chatId: parentChatId }}
        className="archived-unarchive-btn"
        data-testid="parent-chat-bar-link"
        title="Open chat"
        onOpen={() => navigate(`/chats/${parentChatId}`)}
      >
        Open chat
      </OpenableButton>
      <button
        type="button"
        className="archived-unarchive-btn"
        data-testid="parent-chat-bar-dismiss"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => {
          dismissed.add(chatId);
          setHidden(true);
        }}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
