import { randomUUID } from 'node:crypto';
import type { LimitFacts, SdkBackend, SdkEnvelope, SdkRunOptions } from './sdkBackend.js';
import { TurnFailedError, trackLiveRun } from './sdkBackend.js';
import { isAccountExhausted } from './accountFailover.js';
import { persistedUserContent } from './history.js';
import { CodexAccounts } from './codexAccounts.js';
import { CodexHistory } from './codexHistory.js';
import type { CodexNotification, RpcObject } from './codexClient.js';
import { discoverSkills, skillCatalogueText } from './projectSkills.js';
import { DurableCodexProcess } from './codexDurable.js';
import { keepRunnerLog, retireTurn, turnDirFor } from './durableTurn.js';

export function codexPermission(mode: SdkRunOptions['permissionMode']): {
  approvalPolicy: string;
  sandbox: string;
} {
  if (mode === 'bypassPermissions')
    return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  if (mode === 'plan') return { approvalPolicy: 'on-request', sandbox: 'read-only' };
  if (mode === 'acceptEdits' || mode === 'default')
    return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  throw new Error(
    'Codex does not support Claude auto permissions. Choose default, accept edits, plan, or bypass permissions.',
  );
}
export function codexItem(item: RpcObject, complete: boolean): SdkEnvelope | undefined {
  const envelope = codexItemEnvelope(item, complete);
  return envelope && typeof item.id === 'string' ? { ...envelope, nativeId: item.id } : envelope;
}
/**
 * The model's reasoning on a completed Codex item, as the history log keeps it
 * (spec/04 § History). Undefined for any other item.
 */
export function codexThinking(item: RpcObject, complete: boolean): SdkEnvelope | undefined {
  if (!complete || item.type !== 'reasoning') return undefined;
  const parts = [...(item.summary ?? []), ...(item.content ?? [])].filter(
    (p: unknown): p is string => typeof p === 'string' && p.length > 0,
  );
  if (parts.length === 0) return undefined;
  return {
    type: 'system',
    thinking: parts.join('\n'),
    ...(typeof item.id === 'string' ? { nativeId: item.id } : {}),
  };
}
function codexItemEnvelope(item: RpcObject, complete: boolean): SdkEnvelope | undefined {
  if (item.type === 'agentMessage' && complete) return { type: 'assistant', content: item.text };
  const name =
    item.type === 'commandExecution'
      ? 'Bash'
      : item.type === 'fileChange'
        ? 'Edit'
        : item.type === 'mcpToolCall'
          ? `mcp__${item.server}__${item.tool}`
          : undefined;
  if (!name) return undefined;
  if (!complete)
    return {
      type: 'tool_use',
      tool: {
        name,
        callId: item.id,
        args:
          item.arguments ??
          (item.type === 'commandExecution'
            ? { command: item.command }
            : { changes: item.changes }),
      },
    };
  return {
    type: 'tool_result',
    toolResult: {
      name,
      callId: item.id,
      result: item.aggregatedOutput ?? item.result ?? item.error ?? item.changes ?? '',
      isError: item.status === 'failed' || Boolean(item.error),
    },
  };
}
/**
 * Codex's typed out-of-credit code, mapped into the shared limit facts. Codex
 * names it `usageLimitExceeded` on the app-server wire and `usage_limit_exceeded`
 * in the API error body; both mean this account has no credit left.
 */
export function codexLimitOf(error: unknown): LimitFacts | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as Record<string, unknown>;
  const code = e['codexErrorInfo'] ?? e['code'] ?? e['type'];
  return code === 'usageLimitExceeded' || code === 'usage_limit_exceeded'
    ? { kind: 'usage_limit_exceeded', status: 'rejected' }
    : undefined;
}
export class CodexTurnError extends TurnFailedError {
  constructor(
    message: string,
    readonly retrySafe: boolean,
    limit?: LimitFacts,
  ) {
    super(message, limit);
  }
}
/**
 * Codex's `config.mcp_servers` for one turn: `patch` first, then
 * `opts.extraMcpServers` in list order — Claude Code's own discovered config
 * merged ahead of the host's enabled Settings → MCP list, the same set a
 * Claude chat on this host gets (`sdkBackend.ts` `buildSdkEnv`) — and gated the
 * same way: nothing at all when the caller configured no patch tools server.
 */
export function codexMcpServers(
  opts: Pick<SdkRunOptions, 'mcpServer' | 'extraMcpServers' | 'patchMcpOff' | 'disabledTools'>,
): Record<string, RpcObject> | undefined {
  if (!opts.mcpServer) return undefined;
  const servers: Record<string, RpcObject> = opts.patchMcpOff
    ? {}
    : { patch: { ...opts.mcpServer, enabled: true } };
  for (const s of opts.extraMcpServers ?? []) {
    servers[s.name] =
      'url' in s
        ? { url: s.url, enabled: true }
        : { command: s.command, args: s.args, env: s.env, enabled: true };
  }
  for (const [server, tools] of codexDisabledMcpTools(opts.disabledTools).byServer) {
    if (servers[server]) servers[server] = { ...servers[server], disabled_tools: tools };
  }
  return servers;
}

/**
 * Splits a chat's exclusion list into what Codex can honour — MCP tools,
 * named `mcp__<server>__<tool>` and switched off per server with Codex's
 * `disabled_tools` — and `unsupported`, the native tool names Codex has no
 * switch for. Those stay a loud error rather than being dropped.
 */
export function codexDisabledMcpTools(disabledTools: readonly string[] | undefined): {
  byServer: Map<string, string[]>;
  unsupported: string[];
} {
  const byServer = new Map<string, string[]>();
  const unsupported: string[] = [];
  for (const id of new Set(disabledTools ?? [])) {
    const m = /^mcp__(.+?)__(.+)$/.exec(id);
    if (!m) {
      unsupported.push(id);
      continue;
    }
    byServer.set(m[1]!, [...(byServer.get(m[1]!) ?? []), m[2]!]);
  }
  return { byServer, unsupported };
}

export class CodexBackend implements SdkBackend {
  constructor(
    private accounts: CodexAccounts,
    readonly history: CodexHistory,
  ) {}
  /**
   * The runner this turn goes under, or undefined when the host has none
   * configured. A reattach that cannot be carried on (the thread or turn was
   * never recorded) is dropped loudly and the turn starts fresh, which is
   * what a turn that never began is owed.
   */
  private durableFor(opts: SdkRunOptions, accountId: string): DurableCodexProcess | undefined {
    const req = opts.durableTurn;
    if (!req) return undefined;
    let attach = req.attach;
    if (attach) {
      const probe = DurableCodexProcess.attachable(req)
        ? new DurableCodexProcess({ ...req, accountId })
        : undefined;
      const r = probe?.recovered;
      if (!r?.threadId || !r.turnId) {
        req.log.warn(
          { chatId: req.chatId, hasThread: Boolean(r?.threadId), hasTurn: Boolean(r?.turnId) },
          'durable codex turn: the previous turn never recorded its thread or turn; starting it again',
        );
        keepRunnerLog(turnDirFor(req.config, req.chatId), 'unrecoverable');
        retireTurn(turnDirFor(req.config, req.chatId));
        attach = undefined;
      }
    }
    return new DurableCodexProcess({
      ...req,
      accountId,
      attach: attach,
    });
  }
  async *run(opts: SdkRunOptions): AsyncIterable<SdkEnvelope> {
    const policy = codexPermission(opts.permissionMode);
    const { unsupported } = codexDisabledMcpTools(opts.disabledTools);
    if (unsupported.length)
      throw new Error(
        `Codex cannot switch off these tools for this chat: ${unsupported.join(', ')}`,
      );
    const { accountId } = await this.accounts
      .resolveChosen(opts.accountId, opts.model?.startsWith('openai/api/') ? 'apiKey' : 'chatgpt')
      .catch((error: Error) => {
        throw new CodexTurnError(error.message, true);
      });
    const durable = this.durableFor(opts, accountId);
    const attached = durable?.attaching ? durable.recovered : undefined;
    let client: Awaited<ReturnType<CodexAccounts['turnClient']>>;
    try {
      client = await this.accounts.turnClient(accountId, durable);
    } catch (error) {
      durable?.release();
      throw error;
    }
    // Codex fixes its approval policy when the turn starts, so a mode chosen
    // mid-turn is honoured here: bypass answers approval requests itself.
    const tracked =
      opts.chatId !== undefined
        ? trackLiveRun(opts.chatId, opts.permissionMode ?? 'default')
        : undefined;
    try {
      const prior = opts.resumeSessionId;
      // Patch never carries another provider's session into Codex (spec/04 §
      // Provider switches): a non-Codex prior here is a caller bug, refused
      // before it fails confusingly deep inside the RPC call.
      if (prior && !prior.startsWith('codex-')) {
        throw new Error('A session of another provider cannot be resumed with Codex');
      }
      const config: RpcObject = {};
      const mcpServers = codexMcpServers(opts);
      if (mcpServers) config.mcp_servers = mcpServers;
      const base = {
        model: opts.model?.replace(/^openai\/(?:api\/)?/, ''),
        cwd: opts.cwd,
        ...policy,
        config,
        ...(opts.systemPrompt ? { baseInstructions: opts.systemPrompt } : {}),
        ...(opts.toolsPrompt ? { developerInstructions: opts.toolsPrompt } : {}),
      };
      const point = opts.fork?.resumeAtUuid;
      const fresh = !prior || (opts.fork && point === null);
      const codexPrior = prior && prior.startsWith('codex-') ? prior : undefined;
      const params = fresh
        ? base
        : {
            ...base,
            threadId: codexPrior!.slice(6),
            path: this.history.providerPath(codexPrior!),
            ...(point?.startsWith('before:')
              ? { beforeTurnId: point.slice(7) }
              : point?.startsWith('through:')
                ? { lastTurnId: point.slice(8) }
                : {}),
          };
      // A turn the previous host left running is already on its thread, which
      // that host started or resumed, injected into and sent the prompt to.
      const response: RpcObject = attached
        ? { thread: { id: attached.threadId, path: attached.threadPath } }
        : await client.request(
            fresh ? 'thread/start' : opts.fork ? 'thread/fork' : 'thread/resume',
            params,
          );
      const threadId: string = response.thread.id;
      const sessionId = 'codex-' + threadId;
      this.history.begin(sessionId, response.thread.path);
      if (!attached && codexPrior && point) this.history.fork(codexPrior, sessionId, point);
      yield { type: 'system', sessionId };
      const queue: CodexNotification[] = [];
      let wake: (() => void) | undefined;
      // No elapsed-time limit: a long tool is not a failure and the host cannot tell slow from stuck.
      // Only the user's stop, or the turn itself ending, finishes it.
      const unsubscribe = client.subscribe((message) => {
        if (message.params.threadId === threadId || message.method === 'patch/processFailed') {
          queue.push(message);
          wake?.();
        }
      });
      let turnId: string | undefined = attached?.turnId;
      // A turn reattached after a restart may have run anything: never re-plan it.
      let toolsStarted = Boolean(attached);
      let consumedOffset: number | undefined;
      let interruption: Promise<void> | undefined;
      const interrupt = (): void => {
        if (turnId && !interruption)
          interruption = (async () => {
            const descendants = await client.descendants();
            try {
              await client.request('turn/interrupt', { threadId, turnId });
              const deadline = Date.now() + 20000;
              while (Date.now() < deadline) {
                const snapshot = await client.request('thread/read', {
                  threadId,
                  includeTurns: true,
                });
                const turn = snapshot.thread.turns?.find((t: RpcObject) => t.id === turnId);
                if (turn && turn.status !== 'inProgress') {
                  this.history.setPending(sessionId, null);
                  return;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              throw new Error('Codex did not confirm interruption');
            } finally {
              client.terminateDescendants(descendants);
              await client.close();
            }
          })();
        wake?.();
      };
      opts.abortController.signal.addEventListener('abort', interrupt, { once: true });
      try {
        const pending = attached ? null : this.history.pending(sessionId);
        let previous: RpcObject | undefined;
        if (pending) {
          const snapshot = await client.request('thread/read', { threadId, includeTurns: true });
          previous = snapshot.thread.turns?.find((t: RpcObject) =>
            t.items?.some((i: RpcObject) => i.type === 'userMessage' && i.clientId === pending.id),
          );
          // Codex records a turn before it runs anything, so a successful read
          // that has no such turn proves the process died first: nothing ran.
          // Drop the marker and send the prompt fresh below. (A failed read
          // throws above and leaves the marker, since that is truly unknown.)
          // A retry of a turn that died (failed/interrupted, not running and
          // not finished) is the same: we cannot resume it, so drop the marker
          // and start a fresh turn rather than make the user retry twice.
          if (
            previous &&
            previous.status !== 'inProgress' &&
            previous.status !== 'completed' &&
            pending.prompt === opts.prompt
          )
            previous = undefined;
          if (!previous) this.history.setPending(sessionId, null);
        }
        if (pending && previous) {
          this.history.append(sessionId, previous.id, opts.chatId ?? threadId, {
            type: 'user',
            content: persistedUserContent(pending.prompt) ?? pending.prompt,
          });
          toolsStarted =
            previous.items?.some((i: RpcObject) => Boolean(codexItem(i, false))) ?? false;
          if (previous.status === 'inProgress') {
            if (pending.prompt !== opts.prompt)
              throw new Error(
                'The previous Codex turn is still running. Stop it before sending another turn.',
              );
            turnId = previous.id;
          } else {
            this.history.setPending(sessionId, null);
            for (const item of previous.items ?? []) {
              const startedItem = codexItem(item, false);
              if (startedItem)
                this.history.append(sessionId, previous.id, opts.chatId ?? threadId, startedItem);
              const envelope = codexItem(item, true);
              if (envelope) {
                this.history.append(sessionId, previous.id, opts.chatId ?? threadId, envelope);
                if (pending.prompt === opts.prompt) yield envelope;
              }
            }
            if (pending.prompt === opts.prompt) {
              yield { type: 'result', sessionId };
              return;
            }
          }
        }
        if (!turnId) {
          if (opts.abortController.signal.aborted) throw new Error('Codex turn interrupted');
          const clientId = randomUUID();
          this.history.setPending(sessionId, { id: clientId, prompt: opts.prompt });
          // Codex never scans .claude/skills, so hand it a freshly-read
          // catalogue every turn (no cache: renames show up immediately).
          const catalogue = opts.cwd ? skillCatalogueText(discoverSkills(opts.cwd)) : undefined;
          const started = await client.request('turn/start', {
            threadId,
            clientUserMessageId: clientId,
            input: [
              ...(catalogue ? [{ type: 'text', text: catalogue, text_elements: [] }] : []),
              { type: 'text', text: opts.prompt, text_elements: [] },
            ],
          });
          turnId = started.turn.id;
        }
        this.history.append(sessionId, turnId!, opts.chatId ?? threadId, {
          type: 'user',
          content: persistedUserContent(opts.prompt) ?? opts.prompt,
        });
        if (opts.abortController.signal.aborted) interrupt();
        while (true) {
          if (opts.abortController.signal.aborted) {
            interrupt();
            await interruption;
            throw new Error('Codex turn interrupted');
          }
          if (!queue.length) {
            let watchdog: ReturnType<typeof setTimeout> | undefined;
            await new Promise<void>((resolve) => {
              wake = resolve;
              watchdog = setTimeout(resolve, 60_000);
            });
            clearTimeout(watchdog);
            if (!queue.length && !opts.abortController.signal.aborted) {
              const snapshot = await client.request('thread/read', {
                threadId,
                includeTurns: true,
              });
              const turn = snapshot.thread.turns?.find((t: RpcObject) => t.id === turnId);
              if (!turn)
                throw new Error(
                  'Codex stopped reporting the active turn; its outcome is uncertain',
                );
              if (turn.status !== 'inProgress') {
                for (const item of turn.items ?? [])
                  queue.push({ method: 'item/completed', params: { threadId, item } });
                queue.push({ method: 'turn/completed', params: { threadId, turn } });
              }
            }
          }
          wake = undefined;
          const message = queue.shift();
          if (!message) continue;
          // The message before this one has been handled in full, and
          // delivered by the consumer, so a restart now resumes after it.
          if (consumedOffset !== undefined) durable?.noteConsumed(consumedOffset);
          consumedOffset = message.offset;
          if (message.params.turnId && message.params.turnId !== turnId) continue;
          if (message.method === 'patch/processFailed') throw new Error(message.params.message);
          if (message.id !== undefined) {
            if (message.method.endsWith('/requestApproval')) {
              const decision =
                tracked?.live.mode === 'bypassPermissions'
                  ? { approve: true }
                  : await opts.onPermissionRequest?.({
                      tool: message.method.includes('fileChange') ? 'Edit' : 'Bash',
                      args: message.params,
                      description:
                        message.params.reason ??
                        message.params.command ??
                        'Codex requests approval',
                    });
              client.respond(message.id, { decision: decision?.approve ? 'accept' : 'decline' });
            } else if (message.method === 'item/tool/requestUserInput') {
              const questions = message.params.questions as RpcObject[];
              const result = await opts.onPermissionRequest?.({
                tool: 'AskUserQuestion',
                args: {
                  questions: questions.map((q) => ({
                    question: q.question,
                    header: q.header,
                    options: q.options ?? [],
                    multiSelect: false,
                  })),
                },
              });
              const answers = result?.updatedInput?.answers as Record<string, string> | undefined;
              client.respond(message.id, {
                answers: Object.fromEntries(
                  questions.map((q) => [
                    q.id,
                    { answers: answers?.[q.question] ? [answers[q.question]] : [] },
                  ]),
                ),
              });
            } else
              client.respond(message.id, undefined, `Unsupported Codex request: ${message.method}`);
            continue;
          }
          let envelope: SdkEnvelope | undefined;
          if (message.method === 'item/agentMessage/delta')
            envelope = { type: 'assistant_delta', content: message.params.delta };
          if (message.method === 'item/started' || message.method === 'item/completed') {
            const thinking = codexThinking(
              message.params.item,
              message.method === 'item/completed',
            );
            // Thinking is for the history log only — not part of Codex's own
            // transcript reconstruction.
            if (thinking) yield thinking;
            envelope = codexItem(message.params.item, message.method === 'item/completed');
          }
          if (envelope?.type === 'tool_use') toolsStarted = true;
          if (message.method === 'thread/tokenUsage/updated') {
            const usage = message.params.tokenUsage as RpcObject | undefined;
            const window = usage?.modelContextWindow;
            const input = (usage?.last as RpcObject | undefined)?.inputTokens;
            yield {
              type: 'system',
              tokenUsage: {
                ...(typeof window === 'number' ? { contextWindow: window } : {}),
                ...(typeof input === 'number' ? { inputTokens: input } : {}),
              },
            };
            continue;
          }
          if (envelope) {
            this.history.append(sessionId, turnId!, opts.chatId ?? threadId, envelope);
            yield envelope;
          }
          // A tool call just finished: the tool boundary. Codex takes input
          // into the turn that is already running through `turn/steer`, which
          // is how a message sent mid-turn reaches the agent before the turn
          // ends (spec/04 § Message queueing — delivery at a tool boundary).
          if (envelope?.type === 'tool_result' && opts.onToolBoundary) {
            const text = await opts.onToolBoundary();
            if (text) {
              try {
                await client.request('turn/steer', {
                  threadId,
                  expectedTurnId: turnId,
                  input: [{ type: 'text', text, text_elements: [] }],
                });
              } catch (error) {
                // The message was already taken off the queue and recorded as
                // delivered, so a refusal must be seen, not swallowed (a turn
                // that finished under us, or one Codex will not steer).
                throw new CodexTurnError(
                  `Codex did not take a message sent while it was working: ${(error as Error).message}`,
                  false,
                );
              }
            }
          }
          if (message.method === 'turn/completed') {
            const turn = message.params.turn;
            this.history.setPending(sessionId, null);
            if (turn.status !== 'completed')
              throw new CodexTurnError(
                turn.error?.message ?? `Codex turn ${turn.status}`,
                !toolsStarted,
                codexLimitOf(turn.error),
              );
            yield { type: 'result', sessionId };
            return;
          }
          if (message.method === 'error' && !message.params.willRetry)
            throw new CodexTurnError(
              message.params.error?.message ?? 'Codex turn failed',
              !toolsStarted,
              codexLimitOf(message.params.error),
            );
        }
      } catch (error) {
        if (isAccountExhausted((error as TurnFailedError).limit)) {
          this.accounts.markExhausted(accountId);
          void this.accounts.refresh();
        }
        throw error;
      } finally {
        unsubscribe();
        opts.abortController.signal.removeEventListener('abort', interrupt);
      }
    } finally {
      tracked?.release();
      await this.accounts.releaseTurnClient(client);
    }
  }
}
