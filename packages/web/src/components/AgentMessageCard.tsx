// AgentMessageCard — a message this chat exchanged with another agent, drawn
// as one card in the transcript: "Sent to <chat>" for what this chat sent
// (`patch_send_to`, a voice call's hand-off to the chat's agent) and
// "From <chat>" for what came back (a tagged `patch_send_to` delivery, a side
// thread's send-back, the agent's answer to a hand-off). The two directions
// share one shape so a conversation between chats reads as one.
//
// The other chat's name is the link that opens it. When the other side is not
// a chat this surface can open (the chat's own agent, a side thread) the name
// is plain text.

import type { JSX, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { Markdown } from './Markdown.js';
import { OpenableButton } from './OpenableLink.js';
import { useChatStore } from '../stores/chatStore.js';

export type AgentMessageDirection = 'sent' | 'from';

export function AgentMessageCard({
  direction,
  name,
  chatId,
  text,
  status,
  testid,
}: {
  direction: AgentMessageDirection;
  /** Who is on the other side: a chat's name, "agent", a side thread's name. */
  name: string;
  /** The other chat, when it is one the card can open. */
  chatId?: string;
  text: string;
  /** A short state beside the label ("Waiting"), when the exchange is open. */
  status?: string;
  testid?: string;
}): JSX.Element {
  return (
    <div
      className={`agent-msg agent-msg-${direction}`}
      data-testid={testid ?? `agent-msg-${direction}`}
      data-direction={direction}
      {...(chatId ? { 'data-chat-id': chatId } : {})}
    >
      <div className="agent-msg-head">
        <span className="agent-msg-label">{direction === 'sent' ? 'Sent to' : 'From'}</span>
        {chatId ? (
          <ChatLink chatId={chatId}>{name}</ChatLink>
        ) : (
          <span className="agent-msg-name">{name}</span>
        )}
        {status ? (
          <span className="agent-msg-status" data-testid="agent-msg-status">
            {status}
          </span>
        ) : null}
      </div>
      <div className="agent-msg-text content md" data-testid="agent-msg-text">
        <Markdown content={text} />
      </div>
    </div>
  );
}

function ChatLink({ chatId, children }: { chatId: string; children: ReactNode }): JSX.Element {
  const navigate = useNavigate();
  return (
    <OpenableButton
      opens={{ kind: 'chat', chatId }}
      className="agent-msg-name agent-msg-link"
      data-testid="agent-msg-link"
      title="Open chat"
      onOpen={() => navigate(`/chats/${chatId}`)}
    >
      {children}
      <ArrowUpRight size={13} aria-hidden />
    </OpenableButton>
  );
}

/**
 * The name to show for another chat: its current name when this surface knows
 * it, else the name it carried when the message was sent, else plainly
 * "another chat" — never a guessed one.
 */
export function useChatName(chatId: string, carried?: string | null): string {
  const live = useChatStore((s) => s.chats[chatId]?.name ?? null);
  return live ?? carried ?? 'another chat';
}
