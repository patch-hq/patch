// What of a chat's own history log goes into the server's record (spec/01 §
// Chat record): every logged entry with its provider id, every turn boundary,
// and every answered question. Shared by the live path (a turn boundary is sent
// the moment the log writes it) and the one-time record import (the whole log).

import type {
  ChatTurnEndedEvent,
  ChatTurnStartedEvent,
  LogRecord,
  NativeRef,
  WireEvent,
} from '@patch/wire';

/** The question tool, whose answered cards are history (spec/04 § Questions). */
const QUESTION_TOOL = 'AskUserQuestion';

/** The wire form of a log's turn record, or null for any other record (or one with no turn id). */
export function turnBoundaryOf(
  chatId: string,
  record: LogRecord,
): ChatTurnStartedEvent | ChatTurnEndedEvent | null {
  if (record.turnId === undefined) return null;
  const rec = record.rec;
  if (rec.k === 'turn.start') {
    return {
      type: 'chat.turn_started',
      chatId,
      turnId: record.turnId,
      seq: record.seq,
      at: record.at,
      branchId: record.branchId,
      harness: rec.harness,
      model: rec.model,
      origin: rec.origin,
      ...(rec.sessionId !== undefined ? { sessionId: rec.sessionId } : {}),
      ...(record.nativeRef !== undefined ? { nativeRef: record.nativeRef } : {}),
    };
  }
  if (rec.k === 'turn.end') {
    return {
      type: 'chat.turn_ended',
      chatId,
      turnId: record.turnId,
      seq: record.seq,
      at: record.at,
      outcome: rec.outcome,
      ...(rec.error !== undefined ? { error: rec.error } : {}),
      branchId: record.branchId,
    };
  }
  return null;
}

export interface RecordEntriesOptions {
  /** A tool result with its blob references put back: the server is sent every result whole. */
  rehydrate: (result: unknown) => unknown;
  /** A result whose body could not be read back; it is sent as the reference it is. */
  onUnreadable?: (seq: number, err: Error) => void;
}

/**
 * Every entry of a chat's log as the server's record takes it, in log order:
 * logged events (whole, with `nativeRef`), turn boundaries, and each question
 * that was answered or ran out, as its request and its answer.
 */
export function recordEntries(
  chatId: string,
  records: readonly LogRecord[],
  opts: RecordEntriesOptions,
): WireEvent[] {
  // A question's card is history once it is settled: answered with picks, or
  // expired. Cancelled ones are not; their tool rows tell that story.
  const settled = new Map<string, { approve: boolean; answers?: Record<string, string> }>();
  for (const record of records) {
    if (record.rec.k !== 'permission.decision') continue;
    if (record.rec.by === 'expiry') {
      settled.set(record.rec.requestId, { approve: false });
    } else if (record.rec.decision === 'approve_with_edits') {
      const answers = record.rec.editedInput?.['answers'];
      if (answers !== null && typeof answers === 'object') {
        settled.set(record.rec.requestId, {
          approve: true,
          answers: answers as Record<string, string>,
        });
      }
    }
  }
  const out: WireEvent[] = [];
  for (const record of records) {
    const rec = record.rec;
    if (rec.k === 'event') {
      out.push(withRef(wholeEvent(rec.event as WireEvent, record.seq, opts), record.nativeRef));
      continue;
    }
    const boundary = turnBoundaryOf(chatId, record);
    if (boundary) {
      out.push(boundary);
      continue;
    }
    if (rec.k === 'permission.request' && rec.tool === QUESTION_TOOL) {
      const answer = settled.get(rec.requestId);
      if (!answer) continue;
      out.push(
        {
          type: 'chat.permission_request',
          chatId,
          requestId: rec.requestId,
          request: {
            tool: rec.tool,
            args: rec.args,
            ...(rec.description !== undefined ? { description: rec.description } : {}),
          },
          seq: record.seq,
        },
        {
          type: 'chat.permission_response',
          chatId,
          requestId: rec.requestId,
          approve: answer.approve,
          decision: answer.approve ? 'approve_with_edits' : 'deny',
          ...(answer.answers !== undefined ? { answers: answer.answers } : {}),
        },
      );
    }
  }
  return out;
}

function wholeEvent(event: WireEvent, seq: number, opts: RecordEntriesOptions): WireEvent {
  if (event.type !== 'chat.tool_result') return event;
  try {
    return { ...event, result: opts.rehydrate(event.result) };
  } catch (err) {
    opts.onUnreadable?.(seq, err as Error);
    return event;
  }
}

function withRef(event: WireEvent, ref: NativeRef | undefined): WireEvent {
  return ref === undefined ? event : ({ ...event, nativeRef: ref } as WireEvent);
}
