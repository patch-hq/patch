// Delivering a message from one chat to another (spec/03 § Cross-chat tools):
// the one implementation behind `patch_send_to` and every voice call's
// `send_to_chat`. A chat on this host takes it in-process; any other is reached
// through the server, which relays to the host that owns it. Either way the
// message lands under the caller's `localId`, so its reply can be read from
// the server's record by that id (`patch.reply.request`).

import { formatChatSend, isReservedSpecialThread, type WireEvent } from '@patch/wire';
import { ChatNotFoundError, type Daemon } from './chatRunner.js';

export interface ChatDeliveryDeps {
  daemon: Pick<Daemon, 'submitInput' | 'chatState'>;
  /**
   * Whether this host runs the Manager. When it does not, its copy of a
   * reserved thread is stale and the message goes to the host that does.
   * Unset: no special case.
   */
  runsManager?: () => boolean;
  /** Relays to the owning host; resolves once that host has the message. Unset: no server. */
  sendToRemoteChat?: (req: {
    sourceChatId: string;
    targetChatId: string;
    message: string;
    localId: string;
    voicePrefix?: string;
    revealTarget: boolean;
  }) => Promise<void>;
  /** The audit record of a delivery made here. */
  emitWire?: (event: WireEvent) => void;
}

export interface ChatDeliveryRequest {
  callerChatId: string;
  chatId: string;
  /** What the caller said; the recipient gets it tagged with who sent it. */
  message: string;
  localId: string;
  voicePrefix?: string;
  /** A visible caller brings the recipient into view; hidden automation does not. */
  revealTarget: boolean;
}

export type DeliverToChat = (req: ChatDeliveryRequest) => Promise<void>;

/**
 * Resolves once the chat has the message (queued or started), not when it has
 * answered. Rejects with `ChatNotFoundError` for a chat no host has when there
 * is no server to ask, and with the relay's error when the server or the owning
 * host refused it.
 */
export function createChatDelivery(deps: ChatDeliveryDeps): DeliverToChat {
  const isForeignSpecialThread = (chatId: string): boolean =>
    deps.runsManager !== undefined && !deps.runsManager() && isReservedSpecialThread(chatId);
  return async (req) => {
    const caller = deps.daemon.chatState.get(req.callerChatId);
    // Names where it came from (`@patch/wire` chat-send): the recipient's agent
    // knows who to answer, and surfaces draw it as a "From <chat>" card.
    const delivered = formatChatSend(req.callerChatId, caller?.name ?? null, req.message);
    try {
      if (isForeignSpecialThread(req.chatId)) throw new ChatNotFoundError(req.chatId);
      await deps.daemon.submitInput({
        chatId: req.chatId,
        message: delivered,
        localId: req.localId,
        ...(req.voicePrefix !== undefined ? { voicePrefix: req.voicePrefix } : {}),
        // spec/09 § Whose turn it was: the destination of a send is an agent,
        // not a human. A chat that needs the user's attention asks with patch_notify.
        origin: 'machine',
        fromAgent: req.revealTarget,
      });
    } catch (err) {
      if (!(err instanceof ChatNotFoundError) || !deps.sendToRemoteChat) throw err;
      await deps.sendToRemoteChat({
        sourceChatId: req.callerChatId,
        targetChatId: req.chatId,
        message: delivered,
        localId: req.localId,
        revealTarget: req.revealTarget,
        ...(req.voicePrefix !== undefined ? { voicePrefix: req.voicePrefix } : {}),
      });
      return;
    }
    deps.emitWire?.({
      type: 'patch.send_to',
      sourceChatId: req.callerChatId,
      targetChatId: req.chatId,
      message: req.message,
      localId: req.localId,
      revealTarget: req.revealTarget,
    });
  };
}
