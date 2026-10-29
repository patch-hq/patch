// patch-tools-server — stdio MCP server launched by every SDK query.
//
// Per spec/02-host.md "MCP server" + spec/06 ## Cross-chat tools: the SDK
// passes inline mcpServers configuration that boots this script. The MCP
// child reads PATCH_CHAT_ID + PATCH_DAEMON_SOCKET from env and tags every
// tool call with chatId. Side effects round-trip back to the host over
// the UDS internal endpoints (no auth — same host, same user, mode-0600
// socket, per spec/02 "No auth").
//
// The tools are thin wrappers over the host's
// `/internal/*` endpoints. The heavy lifting lives host-side.

import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export interface PatchToolsServerOptions {
  /** UDS path for host control HTTP. */
  hostSocketPath: string;
  /** chatId baked into env (PATCH_CHAT_ID). */
  chatId: string;
  /**
   * The host's current local key (PATCH_DAEMON_LOCAL_KEY), presented as a
   * Bearer on every socket call (spec/02 § MCP server). The host minted it
   * and put it in this child's environment. The host rotates the key on every
   * start, but this child outlives a host restart, so a string is only the
   * value at launch: pass a function to read the current key on each call.
   */
  localKey: string | (() => string);
  /**
   * Which branch this turn is running on (spec/04 § Branching — PATCH_BRANCH_ID).
   * Absent for a turn on the chat's active branch (every turn before parallel
   * branches existed) — `patch_send_back` has nothing to send FROM in that
   * case and refuses saying so.
   */
  branchId?: string;
}

interface UdsRequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** Bearer presented on the socket. */
  localKey?: string;
}

const CHAT_ID_PARAM = "The target chat's id (from patch_list_chats).";
/** The image plus the viewport it was taken in, so coordinates stay unambiguous. */
function screenshotResult(res: { data: string; mimeType: string; width: number; height: number }) {
  return {
    content: [
      { type: 'image' as const, data: res.data, mimeType: res.mimeType },
      { type: 'text' as const, text: `viewport ${res.width}x${res.height}` },
    ],
  };
}

/** Drops `undefined` so an optional tool argument is absent from the request, not null. */
function definedOnly(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** The one browser tool that is always listed; calling it enables the others. */
const BROWSER_ENTRY_TOOL = 'patch_browser_open';
const TAB_ID_PARAM = 'The tabId returned by patch_browser_open (or listed by patch_browser_tabs).';
/**
 * Build the MCP server with the full patch tool catalogue. Caller wires it
 * to a transport (stdio in production, in-memory pair in tests).
 */
export function buildPatchToolsServer(opts: PatchToolsServerOptions): McpServer {
  const server = new McpServer(
    { name: 'patch-tools', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'To show a design or UI for the user to react to, use a Pad (patch_pad_create) instead of describing it.',
    },
  );
  const callerChatId = opts.chatId;
  const callerBranchId = opts.branchId;

  // The browser toolset is ~25 tools most sessions never touch, so only
  // `patch_browser_open` is listed up front. Calling it switches the rest on
  // (the server tells the client the tool list changed); until then they do
  // not exist for the session.
  const gatedBrowserTools: Array<{ enable: () => void }> = [];
  const registerTool = server.registerTool.bind(server) as typeof server.registerTool;
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    const tool = (
      registerTool as (n: string, ...r: unknown[]) => { enable: () => void; disable: () => void }
    )(name, ...rest);
    if (name.startsWith('patch_browser_') && name !== BROWSER_ENTRY_TOOL) {
      tool.disable();
      gatedBrowserTools.push(tool);
    }
    return tool;
  }) as typeof server.registerTool;
  let browserEnabled = false;
  const enableBrowserTools = (): void => {
    if (browserEnabled) return;
    browserEnabled = true;
    for (const t of gatedBrowserTools) t.enable();
  };

  function uds<T>(req: UdsRequestOptions): Promise<T> {
    const localKey = typeof opts.localKey === 'function' ? opts.localKey() : opts.localKey;
    return udsRequest<T>(opts.hostSocketPath, { ...req, localKey });
  }

  function toolResult(payload: unknown): { content: { type: 'text'; text: string }[] } {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  // ---- patch_peek ---------------------------------------------------------
  server.registerTool(
    'patch_peek',
    {
      description:
        "Read another chat's live state plus the most-recent slice of its wire-event stream — on ANY registered host, not just this one. Returns { chat_state, events, truncated }: chat_state is the snapshot (activity, name, folder, last update); events is the recent wire-event window (default 50, up to 200 via limit); truncated:true means older events exist — call patch_history to paginate. Use to check what a sibling chat is doing right now without sending a message. Read-only, no summary pass.",
      inputSchema: {
        chatId: z.string().min(1).describe(CHAT_ID_PARAM),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ chatId, limit }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(limit));
      // Correlates a cross-host relay to this chat, and rate-limits it — the
      // target may not be local (spec/03 § Cross-chat tools).
      params.set('callerChatId', callerChatId);
      const qs = params.toString();
      const peeked = await uds<unknown>({
        method: 'GET',
        path: `/internal/peek/${encodeURIComponent(chatId)}${qs ? `?${qs}` : ''}`,
      });
      return toolResult(peeked);
    },
  );

  // ---- patch_send_to ------------------------------------------------------
  server.registerTool(
    'patch_send_to',
    {
      description:
        "Agent-to-agent. Deliver a message as a user-turn into another existing chat — on ANY registered host, not just this one — the recipient's agent processes it as if the human sent it. Pass an idempotent localId if you want retries to dedupe.",
      inputSchema: {
        chatId: z.string().min(1).describe(CHAT_ID_PARAM),
        message: z.string().min(1),
        voicePrefix: z
          .string()
          .optional()
          .describe(
            'Tag prepended to the delivered turn to mark it as spoken input. Leave unset for ordinary text.',
          ),
        localId: z.string().min(1).max(128).optional(),
      },
    },
    async ({ chatId, message, voicePrefix, localId }) => {
      const body: Record<string, unknown> = { chatId, message, callerChatId };
      if (voicePrefix !== undefined) body['voicePrefix'] = voicePrefix;
      if (localId !== undefined) body['localId'] = localId;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/send-to', body });
      return toolResult(res);
    },
  );

  // ---- patch_send_back ----------------------------------------------------
  server.registerTool(
    'patch_send_back',
    {
      description:
        'Only callable from a SIDE BRANCH — a chat you were started as a side thread of another conversation, not a chat started directly. Posts your conclusion back into the parent track as a quiet row carrying a short summary the host generates from what you were asked and what you last said. Refused if you are not running on a side branch, or if this branch already sent back once.',
      inputSchema: {},
    },
    async () => {
      if (!callerBranchId) {
        throw new Error(
          'patch_send_back: this turn is not running on a side branch (NO FALLBACK — there is no parent to send back to)',
        );
      }
      const res = await uds<{ ok: boolean; error?: string }>({
        method: 'POST',
        path: '/internal/send-back',
        body: { chatId: callerChatId, branchId: callerBranchId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_doc_suggest ---------------------------------------------------
  server.registerTool(
    'patch_doc_suggest',
    {
      description:
        "Propose a tracked edit to a Markdown document open in Propose mode — rendered to the user as an accept/reject suggestion, never applied directly. Refused outright if the document is not in Propose mode (use Edit/Write in Change mode; use patch_doc_comment in Comment mode — no text tool reaches the document there). `find` must be an EXACT, CURRENTLY UNIQUE substring of the document, same contract Edit's old_string holds. `replace` is what it becomes if accepted — empty string for a pure deletion.",
      inputSchema: {
        path: z.string().min(1).describe("The document's path, relative to this chat's folder."),
        find: z.string().min(1),
        replace: z.string(),
      },
    },
    async (args: { path: string; find: string; replace: string }) => {
      const res = await uds<{ id: string; status: string }>({
        method: 'POST',
        path: '/internal/doc/suggest',
        body: { chatId: callerChatId, path: args.path, find: args.find, replace: args.replace },
      });
      return toolResult(res);
    },
  );

  // ---- patch_doc_comment ----------------------------------------------------
  server.registerTool(
    'patch_doc_comment',
    {
      description:
        "Leave a NEW comment thread on a Markdown document, anchored to a passage — available in every mode (it never touches the document's text). Use when you have something to say about a passage that doesn't call for patch_doc_suggest/Edit — a question, a flag, a note. `anchor` should be a short exact quote from the document.",
      inputSchema: {
        path: z.string().min(1).describe("The document's path, relative to this chat's folder."),
        anchor: z.string().describe('A short exact quote from the document this comment is about.'),
        text: z.string().min(1),
      },
    },
    async (args: { path: string; anchor: string; text: string }) => {
      const res = await uds<{ id: string }>({
        method: 'POST',
        path: '/internal/doc/comment',
        body: { chatId: callerChatId, path: args.path, anchor: args.anchor, text: args.text },
      });
      return toolResult(res);
    },
  );

  // ---- patch_doc_reply ------------------------------------------------------
  server.registerTool(
    'patch_doc_reply',
    {
      description:
        'Reply inside an EXISTING comment thread on a Markdown document — how you answer a comment the user left, which arrives as a <system-reminder> naming the threadId. Available in every mode.',
      inputSchema: {
        path: z.string().min(1).describe("The document's path, relative to this chat's folder."),
        threadId: z.string().min(1),
        text: z.string().min(1),
      },
    },
    async (args: { path: string; threadId: string; text: string }) => {
      const res = await uds<{ id: string }>({
        method: 'POST',
        path: '/internal/doc/reply',
        body: { chatId: callerChatId, path: args.path, threadId: args.threadId, text: args.text },
      });
      return toolResult(res);
    },
  );

  // ---- patch_doc_convert ----------------------------------------------------
  server.registerTool(
    'patch_doc_convert',
    {
      description:
        "Convert a .docx in this chat's folder to the Markdown document editor — the same conversion opening the file in a surface triggers. The original .docx is left untouched; the converted .md lands beside it (same basename). Re-running this on a .docx that hasn't changed since the last conversion is a no-op (reused:true) rather than overwriting any edits made to the .md since. Returns `{mdPath, warnings, reused}` — `warnings` names anything that couldn't convert (tracked changes, embedded objects, multi-column layout), never silently dropped.",
      inputSchema: {
        path: z.string().min(1).describe("The .docx file's path, relative to this chat's folder."),
      },
    },
    async (args: { path: string }) => {
      const res = await uds<{ mdPath: string; warnings: string[]; reused: boolean }>({
        method: 'POST',
        path: '/internal/doc/convert',
        body: { chatId: callerChatId, path: args.path },
      });
      return toolResult(res);
    },
  );

  // ---- patch_doc_export -----------------------------------------------------
  server.registerTool(
    'patch_doc_export',
    {
      description:
        "Export a Markdown document this chat's folder holds to .docx, .pdf or .md — the agent-side equivalent of the editor's Download/Save as menu. Writes the exported file beside the .md (same basename, new extension) and returns `{path, warnings}` — `warnings` names anything the export couldn't carry over (e.g. an image it couldn't embed), never silently dropped. The file's bytes are NOT returned here (base64 would waste context on binary); read the result with a file tool if you need to inspect it, or just tell the user it's there.",
      inputSchema: {
        path: z.string().min(1).describe("The .md file's path, relative to this chat's folder."),
        format: z
          .enum(['docx', 'pdf', 'md'])
          .describe('Output format; the file is written beside the .md with this extension.'),
      },
    },
    async (args: { path: string; format: 'docx' | 'pdf' | 'md' }) => {
      const res = await uds<{ path: string; warnings: string[] }>({
        method: 'POST',
        path: '/internal/doc/export',
        body: { chatId: callerChatId, path: args.path, format: args.format },
      });
      return toolResult(res);
    },
  );

  // ---- patch_spawn --------------------------------------------------------
  server.registerTool(
    'patch_spawn',
    {
      description:
        "Create a brand-new persistent chat in a folder, optionally on ANOTHER host. Returns the new chatId and the host it was created on; a spawn the target host refuses (unknown folder, no model catalogue there) fails with that host's own reason, so a result you get back is a chat that really exists. Use when the user wants a new long-lived, user-visible chat as an artifact — not for work that should finish inside this turn. `host` is the hostId of the host to create it on (see patch_list_chats for which hosts chats live on); omitted means this host. `model` is optional — the target host picks its own last-used model. `account` is optional — the id or label of the stored Claude/ChatGPT account the chat starts on (see patch_list_accounts); omitted, the chat runs on whichever account is first in the shared order. An account the host does not hold is refused, never ignored.",
      inputSchema: {
        folder: z.string().min(1),
        host: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        account: z.string().min(1).optional(),
      },
    },
    async ({ folder, host, name, prompt, model, account }) => {
      const body: Record<string, unknown> = { folder, callerChatId };
      if (host !== undefined) body['host'] = host;
      if (account !== undefined) body['account'] = account;
      if (model !== undefined) body['model'] = model;
      if (name !== undefined) body['name'] = name;
      if (prompt !== undefined) body['prompt'] = prompt;
      // A cross-host spawn blocks here until the NAMED host answers with
      // its own outcome. NO FALLBACK: a refusal (or an unanswered call) is a
      // tool ERROR naming the host, never a `created:'remote'` for a chat
      // that was never created — an agent orchestrating work on a chat that
      // does not exist is the worst possible failure mode.
      try {
        const res = await uds<{ chatId?: string; host?: string }>({
          method: 'POST',
          path: '/internal/spawn',
          body,
        });
        return toolResult(res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          host !== undefined
            ? `patch_spawn on host ${host} failed, no chat was created: ${message}`
            : `patch_spawn failed, no chat was created: ${message}`,
        );
      }
    },
  );

  // ---- patch_list_accounts ------------------------------------------------
  server.registerTool(
    'patch_list_accounts',
    {
      description:
        "List the shared Claude and ChatGPT accounts every host draws from, in the order a chat with no account of its own tries them, with each backend's routing strategy. Each account has an `id` and a `label` — either is accepted as `account` on patch_spawn. Reordering is a CLI job (`patch accounts order`).",
      inputSchema: {},
    },
    async () => {
      const res = await uds<unknown>({ method: 'GET', path: '/internal/accounts' });
      return toolResult(res);
    },
  );

  // ---- patch_wake_me ------------------------------------------------------
  server.registerTool(
    'patch_wake_me',
    {
      description:
        'Schedule a DURABLE self-wake: the host delivers `message` back into THIS chat as a new turn after a delay, then you decide what to do (re-arm for a loop, or stop). You do NOT wait — call this and END your turn; the host owns the timer and survives restarts. Use for a self-rescheduling reminder/check loop (e.g. nag every 10 min until done). Provide exactly one of `in` (relative: "10m", "1h30m", "90s", or seconds) or `at` (absolute ISO 8601 — compute the user\'s local time yourself). Optional `notAfter` (ISO) voids the wake if it would fire past it. Re-calling REPLACES the pending wake (one per chat). This is NOT a job (jobs fire an external schedule into a new chat) — a job is for a different or new chat, this is for re-invoking THIS one.',
      inputSchema: {
        message: z.string().min(1),
        in: z.union([z.string(), z.number()]).optional(),
        at: z.string().optional(),
        notAfter: z.string().optional(),
      },
    },
    async ({ message, in: inDelay, at, notAfter }) => {
      const body: Record<string, unknown> = { chatId: callerChatId, message };
      if (inDelay !== undefined) body['in'] = inDelay;
      if (at !== undefined) body['at'] = at;
      if (notAfter !== undefined) body['notAfter'] = notAfter;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/wake', body });
      return toolResult(res);
    },
  );

  // ---- patch_loop -----------------------------------------------------------
  server.registerTool(
    'patch_loop',
    {
      description:
        'Arm a DURABLE recurring self-wake: the host delivers `message` back into THIS chat as a new turn every `every`, forever — no need to re-arm it yourself each time (that is `patch_wake_me`; this is for the fixed-cadence case where the interval never changes). Same underlying timer as `patch_wake_me` — one pending wake per chat, arming a loop REPLACES any pending wake_me/loop and vice versa. `every` is a duration ("10m", "1h30m", "90s", or seconds) — the first fire is one `every` from now, then every `every` thereafter. Optional `notAfter` (ISO 8601) stops the loop once a fire would land past it. Stop the loop with `patch_cancel_wake` — there is no separate stop tool.',
      inputSchema: {
        message: z.string().min(1),
        every: z.union([z.string(), z.number()]),
        notAfter: z.string().optional(),
      },
    },
    async ({ message, every, notAfter }) => {
      const body: Record<string, unknown> = { chatId: callerChatId, message, every };
      if (notAfter !== undefined) body['notAfter'] = notAfter;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/wake', body });
      return toolResult(res);
    },
  );

  // ---- patch_cancel_wake --------------------------------------------------
  server.registerTool(
    'patch_cancel_wake',
    {
      description:
        "Cancel this chat's pending self-wake — a one-shot `patch_wake_me` OR a `patch_loop` (stop the loop). No-op if none is pending. Use when the reminder condition is satisfied and you should stop nagging.",
      inputSchema: {},
    },
    async () => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/wake/cancel',
        body: { chatId: callerChatId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_goal_set -------------------------------------------------------
  server.registerTool(
    'patch_goal_set',
    {
      description:
        "Set THIS chat's goal — the same mechanism `/goal <condition>` sets from " +
        'the composer. One per chat; calling this again REPLACES whatever goal was set before. After ' +
        "each turn settles, Patch's own evaluator judges `condition` against the conversation: not met " +
        'continues with the reason as guidance, met or impossible clears it. Unlike the composer command, ' +
        'calling this tool does NOT also send `condition` as a turn — it only arms the evaluator, since ' +
        'you are already mid-conversation. Visible to the user the whole time, via a bar above the chat.',
      inputSchema: {
        condition: z.string().min(1),
      },
    },
    async ({ condition }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/goal',
        body: { chatId: callerChatId, goal: condition },
      });
      return toolResult(res);
    },
  );

  // ---- patch_goal_get -------------------------------------------------------
  server.registerTool(
    'patch_goal_get',
    {
      description:
        "Read THIS chat's goal: the active condition plus live progress (turns evaluated, tokens " +
        "spent, the evaluator's latest verdict/reason), or — once it has resolved — the most recently " +
        'finished one (condition, duration, turns, tokens, outcome, reason). Both are `null` if no goal ' +
        'has ever been set on this chat.',
      inputSchema: {},
    },
    async () => {
      const params = new URLSearchParams({ chatId: callerChatId });
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/goal?${params.toString()}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_goal_clear -----------------------------------------------------
  server.registerTool(
    'patch_goal_clear',
    {
      description:
        "Clear THIS chat's goal without judging it — no met/impossible verdict is recorded, the " +
        'evaluator simply stops. No-op if none is set. Use when the goal is no longer relevant (the ' +
        'user changed direction) rather than letting the evaluator eventually call it impossible.',
      inputSchema: {},
    },
    async () => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/goal',
        body: { chatId: callerChatId, goal: null },
      });
      return toolResult(res);
    },
  );

  // ---- patch_watch ----------------------------------------------------------
  server.registerTool(
    'patch_watch',
    {
      description:
        'Run a command as a DURABLE background task the host itself owns — the replacement for ' +
        "Bash's `run_in_background` (disabled: see the tool-call denial for why). Spawns " +
        '`command` as a detached process the host holds a real pid for, persists it, and returns ' +
        'immediately with `{ taskId }` — it does NOT block this turn. The host polls it in the ' +
        'background and, once it exits, delivers a `[watch]`-prefixed message into THIS chat as a new ' +
        'turn (survives a host restart either way — the task keeps running and is re-attached). Use ' +
        'for anything that takes longer than you want to wait: a build, a long test run, a download. ' +
        "Every line the command prints is its progress: the last one shows in the user's task strip, so print short status lines. " +
        'A `timeoutSec` is required, and every hour you are sent a check-in asking whether it is still working as intended. ' +
        "`cwd` defaults to this chat's own folder.",
      inputSchema: {
        command: z.string().min(1),
        description: z
          .string()
          .min(1)
          .describe(
            'Short human label for what this task is, shown in patch_watch_list and the chat.',
          ),
        timeoutSec: z
          .number()
          .int()
          .positive()
          .describe(
            'REQUIRED maximum run time in seconds. The host kills the task when it is exceeded. Pick a realistic ceiling, not a huge one.',
          ),
        checkInMinutes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'How often, in minutes, you are sent a check-in while this runs. Omit for the default (an hour). A long wait warrants a longer interval, e.g. a 10-hour wait every 5 hours.',
          ),
        cwd: z.string().min(1).optional(),
      },
    },
    async ({ command, description, timeoutSec, checkInMinutes, cwd }) => {
      const body: Record<string, unknown> = {
        chatId: callerChatId,
        command,
        description,
        timeoutSec,
        ...(checkInMinutes !== undefined ? { checkInSec: checkInMinutes * 60 } : {}),
      };
      if (cwd !== undefined) body['cwd'] = cwd;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/watch', body });
      return toolResult(res);
    },
  );

  // ---- patch_watch_list -----------------------------------------------------
  server.registerTool(
    'patch_watch_list',
    {
      description:
        'List every background task THIS chat has running or recently finished — each with its ' +
        'taskId, description, command, status, startedAt, and endedAt/exitCode where it has ended. ' +
        'Use to check on work started with patch_watch without reading its full output.',
      inputSchema: {},
    },
    async () => {
      const params = new URLSearchParams({ chatId: callerChatId });
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/watch?${params.toString()}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_watch_output -----------------------------------------------------
  server.registerTool(
    'patch_watch_output',
    {
      description:
        "Read a patch_watch task's combined stdout+stderr. Pass `tail` to get only the last N lines " +
        'of a long-running task instead of the whole thing.',
      inputSchema: {
        taskId: z.string().min(1).describe('The taskId returned by patch_watch.'),
        tail: z.number().int().positive().optional(),
      },
    },
    async ({ taskId, tail }) => {
      const params = new URLSearchParams({ chatId: callerChatId });
      if (tail !== undefined) params.set('tail', String(tail));
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/watch/${encodeURIComponent(taskId)}/output?${params.toString()}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_watch_stop -----------------------------------------------------
  server.registerTool(
    'patch_watch_stop',
    {
      description:
        'Kill a running patch_watch task outright (its whole process group). Idempotent: stopping an ' +
        'already-ended task returns `stopped: false` rather than erroring.',
      inputSchema: { taskId: z.string().min(1).describe('The taskId returned by patch_watch.') },
    },
    async ({ taskId }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: `/internal/watch/${encodeURIComponent(taskId)}/stop`,
        body: { chatId: callerChatId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_agent --------------------------------------------------------
  server.registerTool(
    'patch_agent',
    {
      description:
        'Run a scoped sub-task in a Patch-owned child agent. This is the standard subagent tool: ' +
        'the child is invisible outside this chat, inherits this folder/model by default, and its ' +
        'full result returns directly to this parent rather than through patch_send_to. By default ' +
        'the call waits and returns { id, label, status, reply }. Set background: true to return ' +
        'immediately with { id, label }; Patch keeps the child durable and delivers its final result ' +
        'back into this parent when it settles. Multiple calls may run in parallel. Use patch_spawn ' +
        'for an independent user-visible chat and patch_send_to for an existing independent chat.',
      inputSchema: {
        prompt: z.string().min(1),
        title: z
          .string()
          .min(1)
          .max(60)
          .optional()
          .describe(
            'Short name (a few words) shown in the chat for this agent and its result. Always give one.',
          ),
        model: z.string().min(1).optional(),
        folder: z.string().min(1).optional(),
        disallowedTools: z
          .array(z.string().min(1))
          .optional()
          .describe('Tool names the child agent must not be allowed to use.'),
        background: z.boolean().optional(),
      },
    },
    async ({ prompt, title, model, folder, disallowedTools, background }) => {
      const body: Record<string, unknown> = {
        chatId: callerChatId,
        prompt,
        wait: background !== true,
      };
      if (title !== undefined) body['title'] = title;
      if (model !== undefined) body['model'] = model;
      if (folder !== undefined) body['folder'] = folder;
      if (disallowedTools !== undefined) body['disallowedTools'] = disallowedTools;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/delegate', body });
      return toolResult(res);
    },
  );

  // ---- patch_browser_open ---------------------------------------------------
  server.registerTool(
    'patch_browser_open',
    {
      description:
        'Open a URL in a REAL browser on this host (Chrome/Chromium, never headless, a normal fingerprint with no automation flags) and return a tabId for the other patch_browser_* tools. If the page has not finished loading after 30 seconds (a bot check such as "verify you are human"), the tab is kept and the result carries `loading: true` — hand the tab to the user with patch_browser_handoff rather than retrying. `profile` (default "logged-in") picks which cookies it carries: "logged-in" is the ONE persistent profile shared by every chat on this host, so a site logged into once stays logged in; "logged-out" is a throwaway profile with no cookies, for a task that must run signed out. Fails clearly, with no fallback to another browser, if the host has no browser component installed. This is the entry point to the browser: the rest of the patch_browser_* tools (read, click, type, navigate, screenshot, …) are switched on for the session by the first successful call here. Use patch_browser_read next to see the page. The user can watch any tab live and take it over at any time: while they drive it your patch_browser_* calls on that tab wait, and when they hand it back the call that waited fails with `user_was_driving` — read the page again before acting, because they may have changed it.',
      inputSchema: {
        url: z.string().min(1),
        profile: z.enum(['logged-in', 'logged-out']).optional(),
      },
    },
    async ({ url, profile }) => {
      const body: Record<string, unknown> = { chatId: callerChatId, url };
      if (profile !== undefined) body['profile'] = profile;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/browser/open', body });
      enableBrowserTools();
      return toolResult(res);
    },
  );

  // ---- patch_browser_read ----------------------------------------------------
  server.registerTool(
    'patch_browser_read',
    {
      description:
        'Read the tab\'s page. `mode` "snapshot" (default): title, url, and a flat list of every visible interactive element (links, buttons, form fields, headings) across iframes and open shadow DOM, each with a `ref` — pass that ref to patch_browser_click/_type/_fill_form/_select/_upload/_interact. Refs are stable: an element keeps its ref across reads and a ref only stops resolving when the element leaves the page. "text": the page\'s whole visible text (or only the element at `ref`), not cut to a label. "structured": headings, tables (headers + rows), lists, links and the article body as data. "accessibility": the browser\'s accessibility tree. Output over `maxChars` (default 50000) is cut and flagged `truncated`. `notices` tells you once if the tab crashed or its browser closed and was reopened; `fileChooserOpen` means a file chooser is waiting for patch_browser_upload.',
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        mode: z.enum(['snapshot', 'text', 'structured', 'accessibility']).optional(),
        ref: z
          .string()
          .min(1)
          .optional()
          .describe('Limit "text" or "accessibility" to this element.'),
        maxChars: z.number().int().min(100).max(500000).optional(),
      },
    },
    async ({ tabId, mode, ref, maxChars }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/read',
        body: definedOnly({ tabId, mode, ref, maxChars }),
      });
      return toolResult(res);
    },
  );

  // ---- patch_browser_click ---------------------------------------------------
  server.registerTool(
    'patch_browser_click',
    {
      description:
        'Click the element at `ref` (from patch_browser_read) with a real mouse event. Ask the user first before a click that is irreversible — submitting a payment, sending a message, placing an order, deleting something.',
      inputSchema: { tabId: z.string().min(1).describe(TAB_ID_PARAM), ref: z.string().min(1) },
    },
    async ({ tabId, ref }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/click',
        body: { tabId, ref },
      });
      return toolResult(res);
    },
  );

  // ---- patch_browser_type ----------------------------------------------------
  server.registerTool(
    'patch_browser_type',
    {
      description:
        'Type `text` into the element at `ref` as real keystrokes, human-paced — not a value set directly. `submit` (default false) presses Enter afterwards. Ask the user first before typing and submitting something irreversible (e.g. sending a message).',
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        ref: z.string().min(1),
        text: z.string(),
        submit: z.boolean().optional(),
      },
    },
    async ({ tabId, ref, text, submit }) => {
      const body: Record<string, unknown> = { tabId, ref, text };
      if (submit !== undefined) body['submit'] = submit;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/browser/type', body });
      return toolResult(res);
    },
  );

  // ---- patch_browser_fill_form ------------------------------------------------
  server.registerTool(
    'patch_browser_fill_form',
    {
      description:
        'Fill several fields of a form in one call: `fields` is a list of `{ref, value}` from patch_browser_read\'s snapshot. Handles text inputs, checkboxes/radios ("true"/"false") and <select>s. Does NOT submit the form — call patch_browser_click on the submit button after, and ask the user first if submitting is irreversible (a payment, a booking, a message).',
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        fields: z.array(z.object({ ref: z.string().min(1), value: z.string() })).min(1),
      },
    },
    async ({ tabId, fields }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/fill_form',
        body: { tabId, fields },
      });
      return toolResult(res);
    },
  );

  // ---- patch_browser_select ---------------------------------------------------
  server.registerTool(
    'patch_browser_select',
    {
      description:
        "Set a <select> at `ref` (from patch_browser_read) to `value` (an option's value or visible text).",
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        ref: z.string().min(1),
        value: z.string(),
      },
    },
    async ({ tabId, ref, value }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/select',
        body: { tabId, ref, value },
      });
      return toolResult(res);
    },
  );

  // ---- patch_browser_upload ---------------------------------------------------
  server.registerTool(
    'patch_browser_upload',
    {
      description:
        'Attach one or more local files (absolute paths on THIS host). `ref` (from patch_browser_read) may be a file input, or the button that opens a file chooser — it is clicked and the chooser filled. Omit `ref` when a click you already made opened a chooser (patch_browser_read says `fileChooserOpen`).',
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        ref: z.string().min(1).optional(),
        filePaths: z
          .array(z.string().min(1))
          .min(1)
          .describe('Absolute paths of the files to attach, on this host.'),
      },
    },
    async ({ tabId, ref, filePaths }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/upload',
        body: definedOnly({ tabId, ref, filePaths }),
      });
      return toolResult(res);
    },
  );

  // ---- patch_browser_screenshot ------------------------------------------------
  server.registerTool(
    'patch_browser_screenshot',
    {
      description:
        "A PNG screenshot of the tab's viewport, to see what patch_browser_read's text cannot (layout, an image, a captcha/bot check). `ref` shoots just that element; `fullPage` shoots the whole scrollable page.",
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        ref: z.string().min(1).optional(),
        fullPage: z.boolean().optional(),
      },
    },
    async ({ tabId, ref, fullPage }) => {
      const res = await uds<{ data: string; mimeType: string }>({
        method: 'POST',
        path: '/internal/browser/screenshot',
        body: definedOnly({ tabId, ref, fullPage }),
      });
      return { content: [{ type: 'image' as const, data: res.data, mimeType: res.mimeType }] };
    },
  );

  // ---- patch_browser_mouse ----------------------------------------------------
  server.registerTool(
    'patch_browser_mouse',
    {
      description:
        'Act at pixel coordinates, the way a person looks at the screen and points: for canvases, maps, custom widgets, drag and drop and wheel scrolling, where patch_browser_read has no ref to give. Coordinates are in the screenshot you were last shown (x right, y down from its top-left). `action`: click, double_click, right_click, move (hover), drag (x,y to toX,toY), scroll (wheel at x,y by scrollX/scrollY pixels, positive = down/right). Returns a fresh screenshot of the result, so you can see what happened without another call. Prefer patch_browser_click with a ref when the element has one. Ask the user first before a click that is irreversible.',
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        action: z.enum(['click', 'double_click', 'right_click', 'move', 'drag', 'scroll']),
        x: z.number(),
        y: z.number(),
        toX: z.number().optional().describe('drag destination x'),
        toY: z.number().optional().describe('drag destination y'),
        scrollX: z.number().optional(),
        scrollY: z.number().optional(),
      },
    },
    async ({ tabId, ...rest }) => {
      const body: Record<string, unknown> = { chatId: callerChatId, tabId };
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
      const res = await uds<{ data: string; mimeType: string; width: number; height: number }>({
        method: 'POST',
        path: '/internal/browser/mouse',
        body,
      });
      return screenshotResult(res);
    },
  );

  // ---- patch_browser_key ------------------------------------------------------
  server.registerTool(
    'patch_browser_key',
    {
      description:
        'Press keys into whatever has focus, in order: key names ("Enter", "Tab", "Escape", "ArrowDown", "PageDown", "a") or chords ("Control+a", "Shift+Tab", "Meta+c"). Use after patch_browser_mouse focuses something, or for shortcuts and navigation keys patch_browser_type cannot send. Returns a fresh screenshot of the result. Ask the user first before a key press that is irreversible (Enter on a payment or send).',
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        keys: z.array(z.string().min(1)).min(1),
      },
    },
    async ({ tabId, keys }) => {
      const res = await uds<{ data: string; mimeType: string; width: number; height: number }>({
        method: 'POST',
        path: '/internal/browser/key',
        body: { chatId: callerChatId, tabId, keys },
      });
      return screenshotResult(res);
    },
  );

  // ---- patch_browser_handoff --------------------------------------------------
  server.registerTool(
    'patch_browser_handoff',
    {
      description:
        'Hand a browser tab to the user so THEY can do what you must not or cannot: type a password, pass 2FA, solve a captcha, approve an OAuth consent screen. The user sees the tab live in this chat, clicks and types into it, and taps Done; this call blocks until they do (or decline, or `timeoutSeconds` passes, default 600) and returns { outcome: done|cancelled|timeout|tab_closed|callback, url }. What they see and type is NEVER shown to you, and `url` has its query and fragment removed. While the hand-off is open every other patch_browser_* tool refuses that tab. Afterwards call patch_browser_read to see where the page ended up. For an OAuth flow whose redirect is http://localhost:<port>/…, pass that port as `callbackPort` (the process listening on it must already be running on this host): the redirect is delivered to it for you without you ever seeing the authorization code, and the hand-off ends with outcome `callback`. `reason` is shown to the user — say plainly what they need to do. To let the user LOOK at a page for review (a local app on this headless host, say) set `share: true`: the call returns at once with { shared, handoffId, url }, the tab stays open to them with no timeout, you keep full use of the tab and see its content as usual, and their feedback arrives as ordinary chat messages. It ends when they close the view or the tab closes; do not combine with `callbackPort` or `timeoutSeconds`.',
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        reason: z.string().min(1),
        callbackPort: z.number().int().min(1).max(65535).optional(),
        timeoutSeconds: z.number().int().min(10).max(3600).optional(),
        share: z.boolean().optional(),
      },
    },
    async ({ tabId, reason, callbackPort, timeoutSeconds, share }) => {
      const body: Record<string, unknown> = { chatId: callerChatId, tabId, reason };
      if (share !== undefined) body['share'] = share;
      if (callbackPort !== undefined) body['callbackPort'] = callbackPort;
      if (timeoutSeconds !== undefined) body['timeoutSeconds'] = timeoutSeconds;
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/handoff',
        body,
      });
      return toolResult(res);
    },
  );

  // ---- The rest of the agent browser ------------------------------------------
  const browserTool = (
    name: string,
    description: string,
    route: string,
    inputSchema: Record<string, z.ZodTypeAny>,
  ): void => {
    server.registerTool(
      name,
      { description, inputSchema },
      async (args: Record<string, unknown>) => {
        const res = await uds<unknown>({
          method: 'POST',
          path: `/internal/browser/${route}`,
          body: definedOnly(args),
        });
        return toolResult(res);
      },
    );
  };
  const tabIdArg = z.string().min(1).describe(TAB_ID_PARAM);
  const refArg = z.string().min(1).describe('A ref from patch_browser_read.');

  browserTool(
    'patch_browser_navigate',
    'Move an EXISTING tab: `goto` a url, go `back` or `forward` in its history, or `reload`. Returns { title, url, status? }. patch_browser_open is for a new tab; this keeps the tab, its cookies and its place in the tab list. Call patch_browser_read after.',
    'navigate',
    {
      tabId: tabIdArg,
      action: z
        .enum(['goto', 'back', 'forward', 'reload'])
        .describe('goto needs url; the rest move through history or reload.'),
      url: z.string().min(1).optional().describe('Required for goto.'),
    },
  );
  browserTool(
    'patch_browser_switch_tab',
    'Bring a tab to the front, as a person clicks its tab. A link that opens a new tab (target=_blank, window.open) appears in patch_browser_tabs on its own, with `openerTabId`; switch to it, or just use its tabId directly.',
    'switch_tab',
    { tabId: tabIdArg },
  );
  browserTool(
    'patch_browser_wait',
    'Wait for the page instead of guessing: `text` to appear, `textGone` to vanish, a CSS `selector` to reach `state` (default visible), a `ref` to leave the page (or reach `state`), the address to contain `url`, the network to go idle (`networkIdle`), or a plain pause `ms` (max 30000). Several conditions are waited for in turn. Fails clearly after `timeoutMs` (default 30000, max 120000) — a timeout means the thing did not happen, so look at the page rather than retrying blindly.',
    'wait',
    {
      tabId: tabIdArg,
      text: z.string().min(1).optional(),
      textGone: z.string().min(1).optional(),
      selector: z.string().min(1).optional(),
      state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
      ref: z.string().min(1).optional(),
      url: z.string().min(1).optional(),
      networkIdle: z.boolean().optional(),
      ms: z.number().int().min(0).max(30000).optional(),
      timeoutMs: z.number().int().min(100).max(120000).optional(),
    },
  );
  browserTool(
    'patch_browser_interact',
    'What a person does besides click and type. Name the element with `ref` (from patch_browser_read) or, for something with no ref such as a paragraph or a drop zone, a CSS `selector`. `action`: hover, scroll_to (scroll it into view), drag (onto `toRef` / `toSelector`, real mouse drag and drop), press (focus it, then press `keys` — names or chords like "Enter", "Control+a"), select_text (`text` selects just that substring, else all of the element), copy / paste (Ctrl/Cmd+C / +V on whatever has focus), clipboard_read, clipboard_write (`text`; the page must be https or localhost). Ask the user first before anything irreversible.',
    'interact',
    {
      tabId: tabIdArg,
      action: z.enum([
        'hover',
        'scroll_to',
        'drag',
        'press',
        'select_text',
        'copy',
        'paste',
        'clipboard_read',
        'clipboard_write',
      ]),
      ref: refArg.optional(),
      selector: z
        .string()
        .min(1)
        .optional()
        .describe('CSS selector, for an element that has no ref.'),
      toRef: refArg.optional().describe('drag: the element to drop onto.'),
      toSelector: z.string().min(1).optional().describe('drag: CSS selector of the drop target.'),
      keys: z.array(z.string().min(1)).optional().describe('press: key names or chords.'),
      text: z
        .string()
        .optional()
        .describe('select_text: the substring; clipboard_write: the text.'),
    },
  );
  browserTool(
    'patch_browser_dialog',
    'alert/confirm/prompt/beforeunload boxes never block the tab: an alert (and a beforeunload) is accepted, and a confirm or prompt you did not arm is DECLINED. To answer one yes, call this with `accept: true` (and `promptText` for a prompt) BEFORE the action that opens it; it answers the next one only. With no `accept` it just returns every dialog this tab has shown ({ type, message, handled, auto }) — check it after any action that might have raised one.',
    'dialog',
    {
      tabId: tabIdArg,
      accept: z.boolean().optional(),
      promptText: z.string().optional(),
    },
  );
  browserTool(
    'patch_browser_downloads',
    'Files the browser downloaded, saved on THIS host: { filename, path, bytes, state: saving|done|failed }. Give `tabId` for one tab or omit it for all. `waitSeconds` waits for downloads still saving. Open the `path` with your ordinary file tools.',
    'downloads',
    {
      tabId: z.string().min(1).optional().describe(TAB_ID_PARAM),
      waitSeconds: z.number().int().min(0).max(120).optional(),
    },
  );
  browserTool(
    'patch_browser_state',
    'Cookies and localStorage of the tab\'s browser profile, e.g. to sign in with a saved session. `action`: get (cookies + localStorage origins, optionally only `domain`; the values ARE returned to you), set (`cookies`, `origins` [{origin, localStorage:[{name,value}]}], and/or `localStorage` {key:value} for the page\'s own origin), save (write the whole state to `path` on this host, mode 600 — returns only counts, so secrets stay out of the conversation), load (apply a state file from `path`), clear (`cookies` and/or `localStorage`). The "logged-in" profile is shared by every chat on the host: what you set stays set.',
    'state',
    {
      tabId: tabIdArg,
      action: z.enum(['get', 'set', 'save', 'load', 'clear']),
      domain: z.string().min(1).optional(),
      path: z.string().min(1).optional().describe('save/load: an absolute path on this host.'),
      cookies: z
        .union([z.array(z.record(z.unknown())), z.boolean()])
        .optional()
        .describe(
          'set: cookie objects (name, value, and domain+path or url); clear: true to clear cookies.',
        ),
      origins: z
        .array(
          z.object({
            origin: z.string().min(1),
            localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
          }),
        )
        .optional(),
      localStorage: z
        .union([z.record(z.string()), z.boolean()])
        .optional()
        .describe('set: {key:value} for the current origin; clear: true to clear it.'),
    },
  );
  browserTool(
    'patch_browser_eval',
    'Run JavaScript in the page (or in the iframe whose address contains `frameUrl`) and return its JSON value: an expression ("document.title") or a function ("() => localStorage.length"); promises are awaited. Cut at 100000 characters. For debugging and for reading what the page holds that patch_browser_read does not.',
    'eval',
    {
      tabId: tabIdArg,
      expression: z.string().min(1),
      frameUrl: z.string().min(1).optional(),
    },
  );
  browserTool(
    'patch_browser_console',
    "The tab's console messages and uncaught page errors since it opened (last 500): { type, text, url }. `level` filters (log, warning, error, pageerror …), `limit` the newest N (default 100), `clear` empties the buffer.",
    'console',
    {
      tabId: tabIdArg,
      level: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      clear: z.boolean().optional(),
    },
  );
  browserTool(
    'patch_browser_network',
    "The tab's network requests (last 500): { id, method, url, resourceType, status, mimeType, ms, failure }. `urlContains` filters, `limit` the newest N (default 100), `clear` empties the buffer. Pass `bodyOf` (an id from the list) to get that response's body instead (text up to 100000 chars; binary is only sized).",
    'network',
    {
      tabId: tabIdArg,
      urlContains: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      clear: z.boolean().optional(),
      bodyOf: z.number().int().min(1).optional(),
    },
  );
  browserTool(
    'patch_browser_viewport',
    'Resize the tab (`width`, `height`), emulate a named device (`device`, e.g. "Pixel 7", "iPhone 14": viewport, pixel ratio, touch and the matching mobile user agent) or put it back (`reset`). Returns the resulting size, user agent and pixel ratio. The user agent is changed ONLY when you ask for a device.',
    'viewport',
    {
      tabId: tabIdArg,
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      device: z.string().min(1).optional(),
      reset: z.boolean().optional(),
    },
  );

  // ---- patch_browser_tabs -----------------------------------------------------
  server.registerTool(
    'patch_browser_tabs',
    {
      description:
        'List every open browser tab on this host — tabId, title, url, profile, and `openerTabId` for a tab a link opened — across every chat. A tab that crashed, or whose browser closed, is reopened for you the next time you use it.',
      inputSchema: {},
    },
    async () => {
      const res = await uds<unknown>({ method: 'GET', path: '/internal/browser/tabs' });
      return toolResult(res);
    },
  );

  // ---- patch_browser_close ----------------------------------------------------
  server.registerTool(
    'patch_browser_close',
    {
      description:
        'Close a browser tab opened with patch_browser_open. A "logged-out" tab\'s throwaway cookies go with it.',
      inputSchema: { tabId: z.string().min(1).describe(TAB_ID_PARAM) },
    },
    async ({ tabId }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/close',
        body: { tabId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_history ------------------------------------------------------
  server.registerTool(
    'patch_history',
    {
      description:
        "Paginated read of another chat's history — on ANY registered host, not just this one. limit defaults to 50; values above the 200 hard cap are clamped to 200 (not rejected). Use after patch_peek when you need older events.",
      inputSchema: {
        chatId: z.string().min(1).describe(CHAT_ID_PARAM),
        fromSeq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Event sequence number to start reading from; omit to start at the beginning of the retained history.',
          ),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ chatId, fromSeq, limit }) => {
      const params = new URLSearchParams();
      if (fromSeq !== undefined) params.set('fromSeq', String(fromSeq));
      if (limit !== undefined) params.set('limit', String(limit));
      // Correlates a cross-host relay to this chat (spec/03 § Cross-chat tools).
      params.set('callerChatId', callerChatId);
      const qs = params.toString();
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/history/${encodeURIComponent(chatId)}${qs ? `?${qs}` : ''}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_list_chats ---------------------------------------------------
  server.registerTool(
    'patch_list_chats',
    {
      description:
        "List all chats the user has, ACROSS every host on the account, identically whichever host a chat lives on. Each entry has chatId, hostId, name, folder, status, activity, pinned, lastUpdated and a one-line preview/statusSummary. Read a chat with patch_peek/patch_history; find one by content with patch_search_chats. Default omits archived. Pass archived='only' for archived only, archived='include' for active+archived. Sorted: pinned first, then most-recent.",
      inputSchema: { archived: z.enum(['only', 'include']).optional() },
    },
    async ({ archived }) => {
      const params = new URLSearchParams();
      params.set('callerChatId', callerChatId);
      if (archived !== undefined) params.set('archived', archived);
      const qs = params.toString();
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/chats${qs ? `?${qs}` : ''}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_search_chats --------------------------------------------------
  server.registerTool(
    'patch_search_chats',
    {
      description:
        'Search every chat on the account, on ANY host, through the Patch server. Case-insensitive substring match on chat name, folder, status summary and message text. Returns { results, truncated, chatsWithoutLog }: results are best first (name matches outrank body matches, then most recent), each with chatId, hostId, name, folder, status, matchedIn and up to three message excerpts (seq, role, text). chatsWithoutLog counts chats the server holds no message log for — those were matched on metadata only, so a miss is not proof a chat never said it. Follow up with patch_history for the full chat. Read-only.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Text to find in chat names, folders, summaries and messages.'),
        limit: z.number().int().positive().max(100).optional().describe('Max chats, default 20.'),
      },
    },
    async ({ query, limit }) => {
      const params = new URLSearchParams();
      params.set('callerChatId', callerChatId);
      params.set('query', query);
      if (limit !== undefined) params.set('limit', String(limit));
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/search-chats?${params.toString()}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_activity ------------------------------------------------------
  server.registerTool(
    'patch_activity',
    {
      description:
        "Read the USER'S OWN messages for a window — not agent output, which is already reachable via patch_peek/patch_history. Returns { messages, messagesTruncated, nextMessagesCursor? }. messages are role='user' turns, oldest first, across every host (chatId, chatName, hostId, folder, text, ts — ms-epoch, kind?). `kind` is absent when a person actually typed the message (composer, voice, a fork/side message); otherwise it names what the host fired on its own behalf instead: 'job' (a job's fire into an existing chat), 'hook' (an agent-response hook's resubmit), 'goal' (a goal evaluator's not-met resubmit), or 'machine' (a self-wake, a Manager-sweep nudge/wake, a patch_delegate relay, a `patch chats send-to` from the CLI, a cut-off turn re-sent as 'Carry on' after a host restart, or the todo list advancing — e.g. the 'Carry on'/'Checking in — still working?' lines a stalled chat gets nudged with). Filter on `kind` being absent to see only what a person wrote. `since`/`until` are ms-epoch and the window is capped server-side (30 days) regardless of what you ask for. If `messagesTruncated` is true, re-call with `nextMessagesCursor` as `messagesCursor` (same since/until) to continue. Pass includeSessions:true to ALSO get the user's chat dwell time: `chatSessions` (chatId, chatName, hostId, folder, start, end, durationMs — ms-epoch) are periods a chat was open on a FOCUSED, VISIBLE surface, with `sessionsTruncated` and `nextSessionsCursor?`; page it with `sessionsCursor` (independent of messagesCursor — a list that was not truncated is re-read from `since`). Without includeSessions the result has no session fields. Read-only.",
      inputSchema: {
        since: z.number().int().nonnegative(),
        until: z.number().int().nonnegative(),
        messagesCursor: z.number().int().nonnegative().optional(),
        includeSessions: z.boolean().optional(),
        sessionsCursor: z.number().int().nonnegative().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('Max rows per list per page, up to 500; page on with messagesCursor.'),
      },
    },
    async ({ since, until, messagesCursor, includeSessions, sessionsCursor, limit }) => {
      const params = new URLSearchParams();
      params.set('callerChatId', callerChatId);
      params.set('since', String(since));
      params.set('until', String(until));
      if (messagesCursor !== undefined) params.set('messagesCursor', String(messagesCursor));
      if (includeSessions !== undefined) params.set('includeSessions', String(includeSessions));
      if (sessionsCursor !== undefined) params.set('sessionsCursor', String(sessionsCursor));
      if (limit !== undefined) params.set('limit', String(limit));
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/activity?${params.toString()}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_stop ---------------------------------------------------------
  server.registerTool(
    'patch_stop',
    {
      description:
        'Stop a running chat (aborts the in-flight SDK query). Idempotent: already-idle chats no-op.',
      inputSchema: { chatId: z.string().min(1).describe(CHAT_ID_PARAM) },
    },
    async ({ chatId }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: `/internal/stop/${encodeURIComponent(chatId)}`,
        body: { callerChatId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_notify -------------------------------------------------------
  server.registerTool(
    'patch_notify',
    {
      description:
        "Tell the user something they did not ask for right now — a build finished, a watched condition tripped, they are still up at 1am. NOT for replying to a turn they just sent. You choose two things and only two: what to say, and how much it matters. Where it lands is not yours to pick — Patch sends it to the desktop when they are at a computer and to the phone when they are not, because only Patch knows where they are. importance: 'silent' makes no sound and asks for nothing now, it is simply there next time they look (a daily summary, a watcher's line); 'normal' is an ordinary notification, held back while they are already at a surface that shows this chat; 'urgent' is 'normal' with a more urgent sound, routed and held back the same way — use it when you can say what is lost by waiting an hour. Tapping it opens this chat, unless deepLink names somewhere better to land (an installed app's custom-scheme or https URI, e.g. the task the notification is about). Your message must NAME where that link goes — say the app or the thing, e.g. 'open it in Citymapper' — because a link the message does not mention is refused and the tap opens this chat instead. quickReplies is at most 2 short strings (e.g. 'Yes', 'Snooze 10 min'); each renders as its own button on the notification that, tapped, sends that exact text back into this chat as the user's reply — use it when you can predict the answer, not as a substitute for asking a real question.",
      inputSchema: {
        message: z.string().min(1),
        importance: z.enum(['silent', 'normal', 'urgent']),
        deepLink: z.string().min(1).optional(),
        quickReplies: z.array(z.string().min(1).max(40)).max(2).optional(),
      },
    },
    async ({ message, importance, deepLink, quickReplies }) => {
      const body: Record<string, unknown> = { message, priority: importance, callerChatId };
      if (deepLink !== undefined) body['deepLink'] = deepLink;
      if (quickReplies !== undefined) body['quickReplies'] = quickReplies;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/notify', body });
      return toolResult(res);
    },
  );

  // ---- patch_speak --------------------------------------------------------
  server.registerTool(
    'patch_speak',
    {
      description:
        "Say something OUT LOUD on a voice device in the house. A different act from notifying: it fills the room, anyone there hears it, and it is gone — no notification is left behind for later. Use it when the user is in the house and away from screens, and the thing is worth saying to the room. deviceId picks a speaker ('kitchen', 'bedroom'); omit it and Patch picks the one most recently used, or all of them quietly if none was. If no speaker is reachable it falls through to a push.",
      inputSchema: {
        message: z.string().min(1),
        deviceId: z.string().min(1).optional(),
      },
    },
    async ({ message, deviceId }) => {
      const body: Record<string, unknown> = { channel: 'speakers', message, callerChatId };
      if (deviceId !== undefined) body['deviceId'] = deviceId;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/notify', body });
      return toolResult(res);
    },
  );

  // ---- patch_ask_human ----------------------------------------------------
  server.registerTool(
    'patch_ask_human',
    {
      description:
        "Say you are BLOCKED until the user does something themselves, in the world: grant a permission the OS will only take by hand, plug something in, sign a form, take a photo. Not for a decision (ask a question) and not for approving a tool (that already prompts) — this is for work only they can do. It pushes to their phone, pulls this chat out of Hidden (or Archived), and leaves the task ON the chat's row until they act on it — so a hidden job cannot sit blocked where nobody is looking, and a missed notification does not lose the request. Say the task as an instruction they could follow without reading the chat ('grant Screen Recording to Foreman Observer in System Settings'), and put the consequence in `why` ('until then I am judging your day from window titles alone'). Having called it, decide for yourself whether to wait or carry on with what is still possible.",
      inputSchema: {
        task: z.string().min(1),
        why: z.string().min(1).optional(),
      },
    },
    async ({ task, why }) => {
      const body: Record<string, unknown> = { task, callerChatId };
      if (why !== undefined) body['why'] = why;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/ask_human', body });
      return toolResult(res);
    },
  );

  // ---- patch_report -------------------------------------------------------
  server.registerTool(
    'patch_report',
    {
      description:
        "Say this chat is worth the user SEEING, when nothing is blocked and nothing is being asked. It takes the chat out of Archived and puts one line on its row in the sidebar. It makes NO sound — use patch_notify if it also needs to reach them now; the two are independent and a chat can do either, both, or neither. This is the only sidebar state an agent chooses for itself, so hold a high bar: the user may have twenty jobs finish overnight and wants the one or two that actually matter, not twenty rows saying a job ran. A job that did what it always does and found nothing unusual should say NOTHING and stay hidden. Write the summary as the finding itself ('the backup has been failing silently since Tuesday'), not as a description of the run ('backup check complete').",
      inputSchema: {
        summary: z.string().min(1).max(200),
      },
    },
    async ({ summary }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/report',
        body: { summary, callerChatId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_artifact -----------------------------------------------------
  server.registerTool(
    'patch_artifact',
    {
      description:
        "Publish an HTML file from this chat's folder as a page the user can open — Patch's own Artifact tool. Use it whenever the answer is better as a page than as chat text (a report, a dashboard, a table, a rendered result): write the .html file, then publish it. Returns { artifactId, url, title }; the page appears as a card in the chat and opens in Patch's side panel. Republishing the SAME path replaces that page at the same URL, so iterate on one file instead of making new ones. path is relative to the chat folder; HTML only; 2 MB max.",
      inputSchema: {
        path: z.string().min(1),
        title: z.string().min(1).optional(),
      },
    },
    async ({ path, title }) => {
      const body: Record<string, unknown> = { path, callerChatId };
      if (title !== undefined) body['title'] = title;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/artifact', body });
      return toolResult(res);
    },
  );

  // ---- patch_pad_* ---------------------------------------------------------
  const padCall = async (body: Record<string, unknown>): Promise<ReturnType<typeof toolResult>> =>
    toolResult(
      await uds<unknown>({
        method: 'POST',
        path: '/internal/pad',
        body: { ...body, callerChatId },
      }),
    );

  server.registerTool(
    'patch_pad_create',
    {
      description:
        'Start a Pad: a design space the user opens beside this chat and edits directly (select, move, resize, retype, delete, note, draw). Use it whenever you would otherwise describe a design in words, send a screenshot or ask "what do you think of this layout" — the user reacts to the real thing. WORKFLOW: (1) Put the screens in a folder in this chat\'s folder, ideally inside the project (e.g. projects/<app>/design/<name>/), not a temp dir: one .html file per screen (index.html first), or a pad.json `{ "screens": [{ "id", "name", "path" }] }` (path may carry a #fragment); assets load relative to the folder. Screens fill the viewport and are responsive; no fake device frames or title banners. (2) For a change to an existing screen, start from the app\'s REAL markup and styles, not a from-scratch mockup. (3) Check each screen renders (desktop and phone width) before creating. (4) Call this tool; the Pad appears as a card in this chat — there is no link to hand over. (5) The user\'s changes stay pending in the Pad until they are sent; when the user says they have made changes, or patch_pad_list shows some pending, call patch_pad_collect(padId) yourself rather than asking them to press Send. Either way they arrive as a [Pad] message with a picture of each: open every picture before acting, make each change real in the source in the code\'s own idiom, then call patch_pad_update(padId, dir) to publish the revision and patch_pad_reply(padId, text) to close the batch. Fails with "no index.html or pad.json in <dir>" if the folder has neither. `app` files the Pad under that app\'s name (e.g. "Patch"); `device` is how it opens (default desktop). Returns { id, name, screens }; the Pad appears as a card in this chat.',
      inputSchema: {
        dir: z.string().min(1),
        name: z.string().min(1),
        app: z.string().min(1).optional(),
        device: z.enum(['desktop', 'phone']).optional(),
      },
    },
    async ({ dir, name, app, device }) =>
      padCall({ op: 'create', dir, name, ...(app ? { app } : {}), ...(device ? { device } : {}) }),
  );

  server.registerTool(
    'patch_pad_update',
    {
      description:
        "Replace the contents of a Pad this chat created with the current files in `dir` — new and changed screens, new assets, removed screens. The user's pending changes stay; an open editor reloads itself. Use it after acting on a [Pad] message (before patch_pad_reply), or to add a screen. Needs a Pad from patch_pad_create; the folder needs index.html or pad.json. Returns { id, name, screens, addedScreens }; the Pad's card in this chat is refreshed.",
      inputSchema: {
        padId: z.string().min(1).describe('The Pad id returned by patch_pad_create.'),
        dir: z.string().min(1),
      },
    },
    async ({ padId, dir }) => padCall({ op: 'update', padId, dir }),
  );

  server.registerTool(
    'patch_pad_reply',
    {
      description:
        'Answer the batch of changes the user sent from a Pad: closes the oldest open batch, marks its changes done and shows your reply under it. Call it once you have acted on a [Pad] message, after patch_pad_update; it fails with "no open batch for this pad" when no [Pad] message is waiting. `text` is one or two lines on what you did.',
      inputSchema: {
        padId: z.string().min(1).describe('The Pad id named in the [Pad] message.'),
        text: z.string().min(1),
      },
    },
    async ({ padId, text }) => padCall({ op: 'reply', padId, text }),
  );

  server.registerTool(
    'patch_meeting_notes',
    {
      description:
        'Change the notes of the meeting running in this chat, when the user asks you to. op "add_point" adds a point (title is "<Speaker>: the main thrust", optional bullets, decided); op "edit_point" rewrites a point by topicId (the id in the meeting context); op "add_research" appends researched bullets to a point, with source {name,url}; op "set_summary" rewrites the summary. Any figure must carry the source you read it from: without one the call is refused. The user sees a chip on your reply saying what changed, so say it in a line too. Fails when this chat has no meeting or the point does not exist.',
      inputSchema: {
        op: z.enum(['add_point', 'edit_point', 'add_research', 'set_summary']),
        title: z.string().min(1).optional(),
        topicId: z.string().min(1).optional(),
        bullets: z.array(z.string().min(1)).max(3).optional(),
        decided: z.boolean().optional(),
        headline: z.string().min(1).optional().describe('Replacement summary for set_summary.'),
        source: z.object({ name: z.string().min(1), url: z.string().url() }).optional(),
      },
    },
    async (args) =>
      toolResult(
        await uds({
          method: 'POST',
          path: '/internal/meeting-notes',
          body: { callerChatId, edit: definedOnly(args) },
        }),
      ),
  );

  server.registerTool(
    'patch_pad_list',
    {
      description:
        'List the Pads this chat owns, with their screens, pending change counts and whether a batch is waiting on you. Pending changes are ones the user made and has not sent: collect them with patch_pad_collect instead of asking the user to press Send.',
      inputSchema: {},
    },
    async () => padCall({ op: 'list' }),
  );

  server.registerTool(
    'patch_pad_collect',
    {
      description:
        "Collect the user's pending changes on a Pad this chat owns — the same as them pressing Send in the Pad. Draws a picture of each change and delivers them to this chat as the usual [Pad] message, which arrives as your next message; act on it, then patch_pad_update and patch_pad_reply as usual. With nothing pending it sends nothing and returns collected: 0. If an earlier batch is still waiting on a reply it stays open and the new one queues behind it — patch_pad_reply answers the oldest first, so reply once per batch. Returns the Pad with { collected, batchId?, message }.",
      inputSchema: {
        padId: z
          .string()
          .min(1)
          .describe('The Pad id returned by patch_pad_create or patch_pad_list.'),
      },
    },
    async ({ padId }) => padCall({ op: 'collect', padId }),
  );

  // ---- view_file ----------------------------------------------------------
  server.registerTool(
    'view_file',
    {
      description:
        "Show a file to the USER, inline in the chat. The opposite of Read: Read pulls a file into YOUR context to work on; view_file puts it on the user's screen and returns only a short ack, so the contents never enter your context. Use it whenever you want them to LOOK at something — a screenshot or diagram you made or found, a chart, a rendered HTML page, a PDF, or a document you made for them. Images (.png .jpg .jpeg .gif .webp .svg) render as a picture; .pdf renders in a viewer; .html renders as a live page; Word/Excel/PowerPoint/OpenDocument, .rtf .epub .csv .tsv .txt .md .json and .zip show as a download card (name, size, download link) — use that to hand over a file you produced instead of telling them a path. Images, PDFs and files 7 MB max, pages 2 MB max. file_path may be absolute or relative to the chat folder, but must resolve inside it. Returns { kind, url, name } — having shown it, do not also Read it back to describe it unless asked; they can see it.",
      inputSchema: {
        file_path: z.string().min(1),
      },
    },
    async ({ file_path }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/view_file',
        body: { file_path, callerChatId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_call ---------------------------------------------------------
  server.registerTool(
    'patch_call',
    {
      description:
        'Ring the user phone-style (concurrent push + desktop ring; first surface to accept wins). On accept, drops the user into a sustained voice call against the calling chat. On decline / 30s timeout / all surfaces missed, falls back to a push notification carrying the reason text. Use sparingly — a call demands attention. Pass chatId to ring on behalf of another chat; otherwise rings for the calling chat.',
      inputSchema: {
        chatId: z.string().min(1).optional(),
        message: z.string().min(1).optional(),
      },
    },
    async ({ chatId, message }) => {
      const body: Record<string, unknown> = { callerChatId };
      if (chatId !== undefined) body['chatId'] = chatId;
      if (message !== undefined) body['message'] = message;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/call', body });
      return toolResult(res);
    },
  );

  return server;
}

// patch_peek response shape (spec/06): chat_state snapshot + recent wire-event
// slice + truncated flag.
export interface PeekChatState {
  chatId: string;
  name: string | null;
  folder: string;
  activity: string;
  status: string;
  pinned: boolean;
  pinnedAt: number | null;
  lastMessages: unknown[];
  lastUpdated: number;
  lastMessage?: string;
  lastError: unknown;
}

export interface PeekResponse {
  chat_state: PeekChatState;
  events: unknown[];
  truncated: boolean;
}

export function peekViaUds(
  socketPath: string,
  chatId: string,
  opts?: { limit?: number; localKey?: string },
): Promise<PeekResponse> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return udsRequest<PeekResponse>(socketPath, {
    method: 'GET',
    path: `/internal/peek/${encodeURIComponent(chatId)}${qs ? `?${qs}` : ''}`,
    ...(opts?.localKey !== undefined ? { localKey: opts.localKey } : {}),
  });
}

/** Internal: HTTP request via UDS, JSON in / JSON out. NO FALLBACK on errors. */
export function udsRequest<T>(socketPath: string, opts: UdsRequestOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.localKey !== undefined) headers['authorization'] = `Bearer ${opts.localKey}`;
    let bodyBuf: Buffer | undefined;
    if (opts.body !== undefined) {
      bodyBuf = Buffer.from(JSON.stringify(opts.body), 'utf8');
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(bodyBuf.length);
    }
    const req = httpRequest(
      // agent:false = a fresh connection per call. The shared keep-alive agent
      // would reuse a socket the host closed when it restarted (EPIPE).
      { socketPath, method: opts.method, path: opts.path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`patch-tools-server: host HTTP ${res.statusCode}: ${text}`));
            return;
          }
          if (text.length === 0) {
            resolve(undefined as unknown as T);
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (err) {
            reject(new Error(`patch-tools-server: bad JSON from host: ${(err as Error).message}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

export async function runPatchToolsServerStdio(): Promise<void> {
  const chatId = process.env['PATCH_CHAT_ID'];
  const hostSocketPath = process.env['PATCH_HOST_SOCKET'] ?? process.env['PATCH_DAEMON_SOCKET'];
  const localKey = process.env['PATCH_DAEMON_LOCAL_KEY'];
  // Where the host writes its current key. This process outlives a host
  // restart and the host mints a new key on every start, so the launch-time
  // env value goes stale; the file is re-read on each call.
  const localKeyFile = process.env['PATCH_DAEMON_LOCAL_KEY_FILE'];
  // Which branch this turn is running on (spec/04 § Branching). Unset for
  // every turn predating parallel branches — reads as the chat's active
  // branch, which has no send-back of its own to make (`patch_send_back`
  // refuses it, below), so this is optional, not NO-FALLBACK like the three
  // above.
  const branchId = process.env['PATCH_BRANCH_ID'];
  if (!chatId || chatId.length === 0) {
    throw new Error('patch-tools-server: PATCH_CHAT_ID env var missing (NO FALLBACK)');
  }
  if (!hostSocketPath || hostSocketPath.length === 0) {
    throw new Error('patch-tools-server: PATCH_HOST_SOCKET env var missing (NO FALLBACK)');
  }
  // The host always sets this for the children it starts. Missing it means
  // this process was not started by a host, and every call it makes would be
  // refused anyway — so it fails here, where the reason is legible.
  if (!localKey || localKey.length === 0) {
    throw new Error('patch-tools-server: PATCH_DAEMON_LOCAL_KEY env var missing (NO FALLBACK)');
  }
  const server = buildPatchToolsServer({
    hostSocketPath,
    chatId,
    localKey:
      localKeyFile && localKeyFile.length > 0
        ? () => {
            const key = readFileSync(localKeyFile, 'utf8').trim();
            if (key.length === 0) {
              throw new Error(`patch-tools-server: ${localKeyFile} is empty (NO FALLBACK)`);
            }
            return key;
          }
        : localKey,
    ...(branchId && branchId.length > 0 ? { branchId } : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
