// A generic OpenAI-compatible agent harness (docs/providers.md § Proposed suite).
//
// One backend that runs a coding-agent turn against any `/chat/completions`
// endpoint — Ollama, llama.cpp, LM Studio, DeepSeek, OpenRouter, Groq, Mistral,
// xAI. Which endpoint a model uses is the caller's `resolveEndpoint`; nothing
// here names a vendor. The turn is a tool-calling loop: stream the reply, run
// the tools the model asked for (Bash, Read, Write), feed results back, repeat
// until the model answers without a tool call.
//
// Sessions are the message list, saved as JSON under `sessionDir` and named
// `oai-<uuid>`, so a later turn resumes by loading it. No fallbacks: a refused
// request, a malformed stream or an unknown tool is an error, not a guess.

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { SdkBackend, SdkEnvelope, SdkRunOptions } from './sdkBackend.js';
import { TurnFailedError } from './sdkBackend.js';

export const OPENAI_COMPAT_SESSION_PREFIX = 'oai-';

export interface OpenAICompatEndpoint {
  /** Up to and including the version segment, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  /** Absent for a local server that takes none. */
  apiKey?: string | undefined;
  /** The model name the endpoint knows. */
  model: string;
}

export interface OpenAICompatOptions {
  resolveEndpoint: (opts: SdkRunOptions) => OpenAICompatEndpoint;
  sessionDir: string;
  /** Hard stop on model round-trips within one turn. */
  maxSteps?: number;
  fetchImpl?: typeof fetch;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export class OpenAICompatError extends TurnFailedError {}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Run a shell command in the working folder and return its output.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a text file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Create or overwrite a text file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
] as const;

/** Which tools a permission mode lets the model see at all. */
export function toolsForMode(mode: SdkRunOptions['permissionMode'], disabled: readonly string[]) {
  const names = mode === 'plan' ? ['Read'] : ['Bash', 'Read', 'Write'];
  return TOOLS.filter(
    (t) => names.includes(t.function.name) && !disabled.includes(t.function.name),
  );
}

export function openaiCompatPermission(mode: SdkRunOptions['permissionMode']): void {
  if (mode === 'auto')
    throw new Error(
      'OpenAI-compatible models do not support Claude auto permissions. Choose default, accept edits, plan, or bypass permissions.',
    );
}

function runBash(command: string, cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((res) => {
    execFile(
      '/bin/bash',
      ['-c', command],
      { cwd, signal, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: unknown }).code ?? 'error') : 0;
        res(`${stdout}${stderr}${err ? `\n[exit ${String(code)}]` : ''}`);
      },
    );
  });
}

export class OpenAICompatBackend implements SdkBackend {
  constructor(private readonly o: OpenAICompatOptions) {}

  private sessionPath(id: string): string {
    return join(this.o.sessionDir, `${id}.json`);
  }

  private load(id: string): Message[] {
    const path = this.sessionPath(id);
    if (!existsSync(path)) throw new Error(`No saved session ${id}`);
    return JSON.parse(readFileSync(path, 'utf8')) as Message[];
  }

  private save(id: string, messages: Message[]): void {
    mkdirSync(dirname(this.sessionPath(id)), { recursive: true });
    writeFileSync(this.sessionPath(id), JSON.stringify(messages));
  }

  async *run(opts: SdkRunOptions): AsyncIterable<SdkEnvelope> {
    openaiCompatPermission(opts.permissionMode);
    const endpoint = this.o.resolveEndpoint(opts);
    const prior = opts.resumeSessionId;
    if (prior && !prior.startsWith(OPENAI_COMPAT_SESSION_PREFIX))
      throw new Error('Another harness’s session cannot be resumed on an OpenAI-compatible model');
    const sessionId = prior ?? `${OPENAI_COMPAT_SESSION_PREFIX}${randomUUID()}`;
    const messages: Message[] = prior
      ? this.load(prior)
      : opts.systemPrompt
        ? [{ role: 'system', content: opts.systemPrompt }]
        : [];
    messages.push({ role: 'user', content: opts.prompt });
    yield { type: 'system', sessionId };

    const tools = toolsForMode(opts.permissionMode, opts.disabledTools ?? []);
    const maxSteps = this.o.maxSteps ?? 50;
    const doFetch = this.o.fetchImpl ?? fetch;
    try {
      for (let step = 0; ; step++) {
        if (step >= maxSteps) throw new Error(`Stopped after ${maxSteps} steps in one turn`);
        if (opts.abortController.signal.aborted) throw new Error('Turn interrupted');
        const res = await doFetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          signal: opts.abortController.signal,
          headers: {
            'content-type': 'application/json',
            ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: endpoint.model,
            messages,
            stream: true,
            ...(tools.length ? { tools } : {}),
          }),
        });
        if (!res.ok || !res.body)
          throw new OpenAICompatError(
            `${endpoint.baseUrl} answered ${res.status}: ${(await res.text()).slice(0, 500)}`,
            res.status === 429 ? { kind: 'rate_limit', status: 'rejected' } : undefined,
          );
        let text = '';
        const calls = new Map<number, ToolCall>();
        for await (const chunk of sse(res.body)) {
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === 'string' && delta.content) {
            text += delta.content;
            yield { type: 'assistant_delta', content: delta.content };
          }
          for (const tc of delta.tool_calls ?? []) {
            const cur = calls.get(tc.index ?? 0) ?? {
              id: tc.id ?? `call_${randomUUID()}`,
              type: 'function' as const,
              function: { name: '', arguments: '' },
            };
            if (tc.function?.name) cur.function.name += tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
            calls.set(tc.index ?? 0, cur);
          }
        }
        const toolCalls = [...calls.values()];
        messages.push({
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
        if (text) yield { type: 'assistant', content: text };
        if (!toolCalls.length) break;
        for (const call of toolCalls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
          } catch {
            throw new OpenAICompatError(
              `The model sent malformed arguments for ${call.function.name}`,
              undefined,
            );
          }
          yield { type: 'tool_use', tool: { name: call.function.name, callId: call.id, args } };
          const { result, isError } = await this.runTool(call.function.name, args, opts, tools);
          messages.push({ role: 'tool', tool_call_id: call.id, content: result });
          yield {
            type: 'tool_result',
            toolResult: { name: call.function.name, callId: call.id, result, isError },
          };
        }
        const extra = await opts.onToolBoundary?.();
        if (extra) messages.push({ role: 'user', content: extra });
      }
    } finally {
      this.save(sessionId, messages);
    }
    yield { type: 'result', sessionId };
  }

  private async runTool(
    name: string,
    args: Record<string, unknown>,
    opts: SdkRunOptions,
    offered: ReadonlyArray<{ function: { name: string } }>,
  ): Promise<{ result: string; isError: boolean }> {
    if (!offered.some((t) => t.function.name === name))
      return { result: `Tool ${name} is not available in this chat`, isError: true };
    const needsApproval =
      opts.permissionMode === 'default' ||
      (opts.permissionMode === 'acceptEdits' && name === 'Bash');
    if (needsApproval) {
      if (!opts.onPermissionRequest) throw new Error('No permission handler for a gated tool call');
      const verdict = await opts.onPermissionRequest({ tool: name, args });
      if (!verdict.approve)
        return { result: verdict.denyMessage ?? 'The user denied this tool call', isError: true };
      if (verdict.updatedInput) args = verdict.updatedInput;
    }
    const path = (): string => {
      const p = String(args['path'] ?? '');
      return isAbsolute(p) ? p : resolve(opts.cwd, p);
    };
    try {
      if (name === 'Bash')
        return {
          result: await runBash(
            String(args['command'] ?? ''),
            opts.cwd,
            opts.abortController.signal,
          ),
          isError: false,
        };
      if (name === 'Read') return { result: readFileSync(path(), 'utf8'), isError: false };
      mkdirSync(dirname(path()), { recursive: true });
      writeFileSync(path(), String(args['content'] ?? ''));
      return { result: `Wrote ${path()}`, isError: false };
    } catch (e) {
      return { result: (e as Error).message, isError: true };
    }
  }
}

interface Chunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

async function* sse(body: ReadableStream<Uint8Array>): AsyncIterable<Chunk> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const part of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(part, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      yield JSON.parse(data) as Chunk;
    }
  }
}
