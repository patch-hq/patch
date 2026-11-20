// The facts a host reports about a chat's turns (spec/12 § Chat status), for
// tests that need a chat to be working, finished or failed. A host never says a
// chat is "running"; it says a turn started, and the server decides the status.

import type { ChatTurnEndedEvent, ChatTurnStartedEvent, TurnOutcome, WireEvent } from '@patch/wire';

let next = 0;
const open = new Map<string, string>();

/** A turn began in `chatId`. */
export function turnStarted(chatId: string, at = Date.now()): ChatTurnStartedEvent {
  const turnId = `t${++next}`;
  open.set(chatId, turnId);
  return { type: 'chat.turn_started', chatId, turnId, seq: -1, at };
}

/** The turn last started in `chatId` ended. */
export function turnEnded(
  chatId: string,
  outcome: TurnOutcome = 'completed',
  error?: { code: string; message: string },
  at = Date.now(),
): ChatTurnEndedEvent {
  const turnId = open.get(chatId) ?? `t${++next}`;
  open.delete(chatId);
  return {
    type: 'chat.turn_ended',
    chatId,
    turnId,
    seq: -1,
    at,
    outcome,
    ...(error ? { error: error as ChatTurnEndedEvent['error'] } : {}),
  };
}

/**
 * A test that describes a host's chat as running, waiting, idle or errored
 * gets the facts a host now reports instead (spec/12 § Chat status): a turn
 * starting, a permission raised and answered, a turn ending with its outcome.
 * Returns the frames to send, in order, the `chat.state` last and without the
 * activity, as a host sends it.
 */
export function createHostFacts(): (event: WireEvent) => WireEvent[] {
  const turns = new Map<string, string>();
  const asking = new Map<string, string>();
  let n = 0;
  return (event) => {
    if (event.type !== 'chat.state' || event.activity === undefined) return [event];
    const { activity, lastError, ...rest } = event;
    const chatId = event.chatId;
    const out: WireEvent[] = [];
    const at = typeof event.lastUpdated === 'number' ? event.lastUpdated : 0;
    const start = (): string => {
      const turnId = `ht${++n}`;
      turns.set(chatId, turnId);
      out.push({ type: 'chat.turn_started', chatId, turnId, seq: -1, at });
      return turnId;
    };
    const resolveAsk = (): void => {
      const requestId = asking.get(chatId);
      if (requestId === undefined) return;
      asking.delete(chatId);
      out.push({ type: 'chat.permission_response', chatId, requestId, approve: true });
    };
    if (activity === 'running' || activity === 'awaiting-permission') {
      const turnId = turns.get(chatId) ?? start();
      if (activity === 'awaiting-permission' && !asking.has(chatId)) {
        const requestId = `p-${turnId}`;
        asking.set(chatId, requestId);
        out.push({
          type: 'chat.permission_request',
          chatId,
          requestId,
          request: { tool: 'Bash', args: {} },
          seq: 0,
        } as unknown as WireEvent);
      }
      if (activity === 'running') resolveAsk();
    } else {
      resolveAsk();
      const turnId = turns.get(chatId) ?? (activity === 'errored' ? start() : undefined);
      if (turnId !== undefined) {
        turns.delete(chatId);
        out.push({
          type: 'chat.turn_ended',
          chatId,
          turnId,
          seq: -1,
          at,
          outcome: activity === 'errored' ? 'failed' : event.turnStopped ? 'stopped' : 'completed',
          ...(activity === 'errored'
            ? {
                error: (lastError
                  ? { code: lastError.code, message: lastError.message }
                  : { code: 'sdk_error', message: 'failed' }) as ChatTurnEndedEvent['error'],
              }
            : {}),
        });
      }
    }
    out.push(rest as WireEvent);
    return out;
  };
}
