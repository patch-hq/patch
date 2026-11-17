// `patch.delegate_control.request` handler — the user's own controls over one
// delegated agent (pause, resume, stop, spin off into its own chat), from the
// running-agent bar. Same server→host→server round-trip as the watch RPCs
// (watchRequests.ts). Thin wrapper over the Daemon's delegate methods; the
// ownership check (is this the parent's own subagent) lives there.

import type { Logger } from 'pino';
import type { PatchDelegateControlRequestEvent, WireEvent } from '@patch/wire';

export interface DelegateControlDeps {
  hasChat(chatId: string): boolean;
  isDelegateOf(parentChatId: string, delegateId: string): boolean;
  pause(parentChatId: string, id: string): Promise<boolean>;
  resume(parentChatId: string, id: string): Promise<boolean>;
  stop(parentChatId: string, id: string): Promise<boolean>;
  spinOff(parentChatId: string, id: string): string | undefined;
}

export async function handleDelegateControlRequest(
  event: PatchDelegateControlRequestEvent,
  deps: DelegateControlDeps,
  sender: (e: WireEvent) => void,
  logger: Logger,
): Promise<void> {
  const reply = (
    r: Omit<Extract<WireEvent, { type: 'patch.delegate_control.response' }>, 'type' | 'requestId'>,
  ): void => sender({ type: 'patch.delegate_control.response', requestId: event.requestId, ...r });
  if (!deps.hasChat(event.chatId)) {
    reply({
      ok: false,
      error: { code: 'chat_not_found', message: `chat not found: ${event.chatId}` },
    });
    return;
  }
  if (!deps.isDelegateOf(event.chatId, event.delegateId)) {
    reply({
      ok: false,
      error: {
        code: 'not_a_delegate',
        message: `${event.delegateId} is not a delegate of ${event.chatId}`,
      },
    });
    return;
  }
  try {
    if (event.action === 'spin_off') {
      const id = deps.spinOff(event.chatId, event.delegateId);
      reply({
        ok: true,
        applied: id !== undefined,
        ...(id !== undefined ? { spunOffChatId: id } : {}),
      });
      return;
    }
    const run = { pause: deps.pause, resume: deps.resume, stop: deps.stop }[event.action];
    reply({ ok: true, applied: await run(event.chatId, event.delegateId) });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, chatId: event.chatId, delegateId: event.delegateId },
      'patch.delegate_control.request failed',
    );
    reply({ ok: false, error: { code: 'internal', message: (err as Error).message } });
  }
}
