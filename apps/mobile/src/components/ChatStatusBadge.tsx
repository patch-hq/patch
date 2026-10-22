// The badge for a chat row, with the unread-notification lift applied
// (mirrors packages/web/src/components/ChatStatusBadge.tsx).

import React from 'react';
import { useChatBadge } from '../lib/chatBadge';
import type { ChatRow } from '../stores/types';
import { StatusBadge } from './StatusBadge';

export function ChatStatusBadge({ row }: { row: ChatRow }): React.ReactElement {
  return <StatusBadge badge={useChatBadge(row)} />;
}
