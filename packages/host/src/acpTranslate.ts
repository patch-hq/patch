// ACP `session/update` notifications → Patch's turn envelopes (spec/02 §
// Provider adapters).
//
// Each envelope carries the agent's own id for what it came from (`nativeId`,
// recorded as the entry's `nativeRef`): the tool call id for a tool, the
// message id for a message where the agent gives one. An agent that gives no
// message id gets one made from where the message began in the turn, which
// stays the same when a reattached host is handed the turn's output again, so
// nothing is recorded twice.
//
// Nothing is reworded. A tool keeps the agent's own name and input; a plan
// is the agent's own plan, recorded as Patch's task list (the same shape as a
// TodoWrite call: content and status per entry).

import type {
  ContentBlock,
  SessionNotification,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { SdkEnvelope } from './sdkBackend.js';

type Update = SessionNotification['update'];

/** What a tool call has said about itself so far. */
interface ToolSeen {
  name: string;
  args: Record<string, unknown>;
  settled: boolean;
}

export function contentText(block: ContentBlock | undefined): string {
  if (!block) return '';
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource_link':
      return `[${block.title ?? block.name}](${block.uri})`;
    case 'resource': {
      const r = block.resource as { text?: unknown; uri?: unknown };
      return typeof r.text === 'string' ? r.text : `[resource](${String(r.uri ?? '')})`;
    }
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    default:
      return '';
  }
}

function toolContentText(content: ToolCallContent[] | null | undefined): string {
  const parts: string[] = [];
  for (const c of content ?? []) {
    if (c.type === 'content') parts.push(contentText(c.content));
    else if (c.type === 'diff') {
      const lines = [`--- ${c.path}`, `+++ ${c.path}`];
      for (const l of (c.oldText ?? '').split('\n')) if (c.oldText) lines.push(`-${l}`);
      for (const l of c.newText.split('\n')) lines.push(`+${l}`);
      parts.push(lines.join('\n'));
    } else if (c.type === 'terminal') parts.push(`[terminal ${c.terminalId}]`);
  }
  return parts.filter((p) => p !== '').join('\n');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toolArgs(call: ToolCall | ToolCallUpdate): Record<string, unknown> {
  if (isRecord(call.rawInput)) return call.rawInput;
  return {
    ...(call.title ? { title: call.title } : {}),
    ...(call.kind ? { kind: call.kind } : {}),
    ...(call.locations?.length ? { locations: call.locations } : {}),
  };
}

export class AcpTranslator {
  private text = '';
  private textRef: string | undefined;
  private thought = '';
  private thoughtRef: string | undefined;
  private readonly tools = new Map<string, ToolSeen>();

  /** `turnKey` names the turn (native session and prompt), for made-up ids. */
  constructor(private readonly turnKey: string) {}

  /** The turn this translator is for, as the history's turn id. */
  get key(): string {
    return this.turnKey;
  }

  /**
   * One update, as the envelopes it produces. `at` is where in the turn's
   * output it arrived, stable across a reattach.
   */
  push(update: Update, at: string): SdkEnvelope[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const out: SdkEnvelope[] = [];
        const ref = update.messageId ?? undefined;
        if (this.thought) out.push(...this.flushThought());
        if (this.text && ref !== undefined && this.textRef !== ref) out.push(...this.flushText());
        const chunk = contentText(update.content);
        if (!chunk) return out;
        if (!this.text) this.textRef = ref ?? `${this.turnKey}:m@${at}`;
        this.text += chunk;
        out.push({ type: 'assistant_delta', content: chunk });
        return out;
      }
      case 'agent_thought_chunk': {
        const out = this.flushText();
        const chunk = contentText(update.content);
        if (!chunk) return out;
        if (!this.thought) this.thoughtRef = update.messageId ?? `${this.turnKey}:t@${at}`;
        this.thought += chunk;
        return out;
      }
      case 'tool_call':
        return [...this.flush(), ...this.toolCall(update)];
      case 'tool_call_update':
        return [...this.flush(), ...this.toolUpdate(update)];
      case 'plan': {
        const out = this.flush();
        const callId = `${this.turnKey}:plan@${at}`;
        const todos = update.entries.map((e) => ({
          content: e.content,
          status: e.status,
          priority: e.priority,
        }));
        out.push(
          {
            type: 'tool_use',
            tool: { name: 'TodoWrite', callId, args: { todos } },
            nativeId: callId,
          },
          {
            type: 'tool_result',
            toolResult: { name: 'TodoWrite', callId, result: 'Plan updated', isError: false },
            nativeId: `${callId}:result`,
          },
        );
        return out;
      }
      case 'usage_update':
        return [
          { type: 'system', tokenUsage: { contextWindow: update.size, inputTokens: update.used } },
        ];
      // The rest change no record: commands, modes, config, titles, notices.
      default:
        return [];
    }
  }

  /**
   * A permission request names its tool call, which the agent may not have
   * announced yet: announce it first, so the question follows the call.
   */
  ensureTool(call: ToolCallUpdate): {
    envelopes: SdkEnvelope[];
    name: string;
    args: Record<string, unknown>;
  } {
    const seen = this.tools.get(call.toolCallId);
    if (seen) {
      if (isRecord(call.rawInput)) seen.args = call.rawInput;
      return { envelopes: [], name: seen.name, args: seen.args };
    }
    const envelopes = [
      ...this.flush(),
      ...this.toolCall({ ...call, title: call.title ?? call.toolCallId } as ToolCall),
    ];
    const now = this.tools.get(call.toolCallId)!;
    return { envelopes, name: now.name, args: now.args };
  }

  /** Whatever text or thought is still open, as finished envelopes. */
  flush(): SdkEnvelope[] {
    return [...this.flushThought(), ...this.flushText()];
  }

  /** Tool calls the turn started and never settled. */
  unsettledTools(): string[] {
    return [...this.tools.entries()].filter(([, t]) => !t.settled).map(([id]) => id);
  }

  private flushText(): SdkEnvelope[] {
    if (!this.text) return [];
    const env: SdkEnvelope = {
      type: 'assistant',
      content: this.text,
      ...(this.textRef ? { nativeId: this.textRef } : {}),
    };
    this.text = '';
    this.textRef = undefined;
    return [env];
  }

  private flushThought(): SdkEnvelope[] {
    if (!this.thought) return [];
    const env: SdkEnvelope = {
      type: 'system',
      thinking: this.thought,
      ...(this.thoughtRef ? { nativeId: this.thoughtRef } : {}),
    };
    this.thought = '';
    this.thoughtRef = undefined;
    return [env];
  }

  private toolCall(call: ToolCall): SdkEnvelope[] {
    if (this.tools.has(call.toolCallId)) return this.toolUpdate(call);
    const name = call.name || call.title || call.kind || 'tool';
    const seen: ToolSeen = { name, args: toolArgs(call), settled: false };
    this.tools.set(call.toolCallId, seen);
    const out: SdkEnvelope[] = [
      {
        type: 'tool_use',
        tool: { name, callId: call.toolCallId, args: seen.args },
        nativeId: call.toolCallId,
      },
    ];
    if (call.status === 'completed' || call.status === 'failed') out.push(...this.settle(call));
    return out;
  }

  private toolUpdate(update: ToolCallUpdate): SdkEnvelope[] {
    const seen = this.tools.get(update.toolCallId);
    if (!seen)
      return this.toolCall({ ...update, title: update.title ?? update.toolCallId } as ToolCall);
    if (isRecord(update.rawInput)) seen.args = update.rawInput;
    if (update.status === 'completed' || update.status === 'failed') return this.settle(update);
    return [];
  }

  private settle(call: ToolCall | ToolCallUpdate): SdkEnvelope[] {
    const seen = this.tools.get(call.toolCallId)!;
    if (seen.settled) return [];
    seen.settled = true;
    const text = toolContentText(call.content);
    const result =
      text !== ''
        ? text
        : call.rawOutput !== undefined
          ? typeof call.rawOutput === 'string'
            ? call.rawOutput
            : JSON.stringify(call.rawOutput)
          : '';
    return [
      {
        type: 'tool_result',
        toolResult: {
          name: seen.name,
          callId: call.toolCallId,
          result,
          isError: call.status === 'failed',
        },
        nativeId: `${call.toolCallId}:result`,
      },
    ];
  }
}
