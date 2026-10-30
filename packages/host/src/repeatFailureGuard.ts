// An agent that re-runs the same failing tool call in a loop — a CLI that is
// blocked on a macOS permission prompt, a command the sandbox refuses — turns
// one failure into hundreds, and each one can raise an OS dialog on the user's
// screen. This spots the loop: the same tool call, with the same arguments,
// failing N times in a row. Any different call, or a success, ends the streak.

/** Identical failing calls in a row before the guard trips. */
export const REPEAT_FAILURE_THRESHOLD = 5;

export interface RepeatTrip {
  tool: string;
  count: number;
  /** The call's arguments, shortened for a notification. */
  summary: string;
}

const SUMMARY_MAX = 120;

function summarise(args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>;
  const command = record['command'];
  const text = typeof command === 'string' ? command : JSON.stringify(args ?? {});
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
}

export class RepeatFailureGuard {
  private readonly calls = new Map<string, { key: string; tool: string; args: unknown }>();
  private readonly streaks = new Map<string, { key: string; count: number }>();

  constructor(private readonly threshold: number = REPEAT_FAILURE_THRESHOLD) {}

  onToolUse(chatId: string, callId: string, tool: string, args: unknown): void {
    this.calls.set(`${chatId}:${callId}`, {
      key: `${tool}\u0000${JSON.stringify(args ?? null)}`,
      tool,
      args,
    });
  }

  /** Returns the trip once, when the streak reaches the threshold; the streak then resets. */
  onToolResult(chatId: string, callId: string, isError: boolean): RepeatTrip | undefined {
    const id = `${chatId}:${callId}`;
    const call = this.calls.get(id);
    this.calls.delete(id);
    if (call === undefined) return undefined;
    if (!isError) {
      this.streaks.delete(chatId);
      return undefined;
    }
    const prev = this.streaks.get(chatId);
    const count = prev?.key === call.key ? prev.count + 1 : 1;
    if (count < this.threshold) {
      this.streaks.set(chatId, { key: call.key, count });
      return undefined;
    }
    this.streaks.delete(chatId);
    return { tool: call.tool, count, summary: summarise(call.args) };
  }

  /** Forget a chat's streak and unanswered calls (turn ended or stopped). */
  clear(chatId: string): void {
    this.streaks.delete(chatId);
    for (const id of this.calls.keys()) if (id.startsWith(`${chatId}:`)) this.calls.delete(id);
  }
}
