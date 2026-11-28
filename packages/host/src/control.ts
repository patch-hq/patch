// Loopback HTTP control plane for the host.
//
// Listens on a Unix-domain socket at ~/.patch/daemon.sock. Two cohabiting
// surfaces:
//
//   1. Local CLI (`/chats/*`) — auth-gated by PATCH_DAEMON_LOCAL_KEY.
//   2. Cross-chat tool MCP child (`/internal/*`) — NO AUTH (per
//      spec/02-host.md: "Daemon, MCP child, and `claude` query all run as
//      the same user on the same host, on a loopback socket"). The UDS is
//      chmod 0600 and the only writers in the process tree are the host
//      and its own MCP children.
//
// `/internal/*` exposes the per-tool primitives the patch-tools MCP server
// dials into. Each tool has a thin Fastify route with a zod-validated body.

import { expandHome } from './expandHome.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, resolve, join, sep } from 'node:path';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import { imageSize } from './imageSize.js';
import {
  BACKEND_IDS,
  MeetingAgentNotesEdit,
  ReminderEvery,
  isReservedSpecialThread,
} from '@patch/wire';
import type {
  HostAccountEvent,
  ClaudeMemoryEntry,
  HostInfoEvent,
  HealthzResponse,
  HostBackend,
  WireEvent,
} from '@patch/wire';
import {
  ChatNotFoundError,
  FolderNotFoundError,
  NoModelCatalogueError,
  type Daemon,
  type SpawnChatOptions,
} from './chatRunner.js';
import { ChatStateMap } from './chatState.js';
import {
  JobNotFoundError,
  JobCreate as JobCreateSchema,
  JobUpdate as JobUpdateSchema,
  JobsLinkOfflineError,
  type AsyncJobsInterface,
} from './jobs-interface.js';
import {
  ArtifactInputError,
  MAX_ARTIFACT_BYTES,
  MAX_VIEW_IMAGE_BYTES,
  MAX_VIEW_PDF_BYTES,
  MAX_VIEW_VIDEO_BYTES,
  MAX_VIEW_FILE_BYTES,
  artifactIdFor,
  resolveArtifactPath,
  resolveViewFilePath,
  toDocument,
  type PublishArtifact,
  type ViewFileKind,
} from './artifacts.js';
import { buildPreviewHtml, previewable } from './viewFilePreview.js';
import type { ServerEventsClient } from './serverEventsClient.js';
import { PadInputError, bundleDir, saveCapture, type PadRequest } from './pads.js';
import {
  AccountRefError,
  AccountsRpcError,
  resolveAccountRef,
  type AccountsRpc,
  type ServerApiRpc,
} from './accountsClient.js';
import {
  BrowserNotInstalledError,
  RefNotFoundError,
  BrowserStoppedError,
  TabNotFoundError,
  type BrowserProfile,
  TabInHandoffError,
  AppBrowserUnavailableError,
  UserDrivingError,
  UserHandedBackError,
} from './browser.js';
import { RateLimiter } from './rate-limit.js';
import { GIT_SHA, VERSION } from './version.js';
import { RemoteRelayError } from './remote-relay.js';
import { createChatDelivery } from './chatDelivery.js';
import { probeFolderAccess } from './folderAccess.js';

/** A stop refused because the chat's provider does not declare interrupt (spec/02 § Provider adapters). */
const INTERRUPT_UNSUPPORTED = {
  error: 'capability_unsupported',
  message: "interrupting a turn is not supported by this chat's provider",
} as const;

/**
 * A cross-host `patch_spawn` the NAMED host refused (or never answered).
 * Carries that host's own error code so the tool call fails with the real
 * reason instead of reporting a chat that was never created.
 */
export class RemoteSpawnError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteSpawnError';
  }
}

/**
 * Validate the `?limit=` query for the jobs runs/webhooks tail routes.
 * Defense-in-depth alongside the CLI's client-side `parseLimit`: a malformed
 * value (e.g. `abc`) must NOT slip through as `NaN` and reach the downstream
 * jobs store, where it previously caused an unhandled 500. NO FALLBACK — a bad
 * limit is a 400 with an actionable message, never a silent default.
 */
function parseRunsLimit(
  raw: string | undefined,
): { ok: true; value: number } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: 50 };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, message: `--limit must be a positive integer (got ${raw})` };
  }
  return { ok: true, value: Math.min(5000, n) };
}

export interface BuildOptions {
  logger?: boolean;
  /** When provided, exposes the host action interface; otherwise endpoints 503. */
  daemon?: Daemon;
  /**
   * The bearer key gating EVERY route on this socket except `/healthz`
   * (spec/02 § Control IPC). Minted by the host on each start and written to
   * `~/.patch/local.key`; the CLI reads that file and the MCP child is handed
   * the value in its environment. Absent → every gated route 401s, which is
   * the safe direction: the socket carries the tool endpoints that spawn
   * chats, fire notifications and edit jobs, all with the host user's
   * authority.
   */
  localKey?: string;
  /**
   * The user's edits of Patch tools' descriptions (spec/06 § Tool prompts),
   * read on each request so the tools process a turn starts sees the current set.
   */
  toolPromptOverrides?: () => Record<string, string>;
  /** Jobs store backing patch_job_*. Production: RemoteJobsStore. Tests: MemoryJobsStore. */
  jobs?: AsyncJobsInterface;
  /** Optional upstream emit hook — used to surface cross-chat tool events for audit. */
  emitWire?: (event: WireEvent) => void;
  /**
   * Is another host linked right now (spec/03 § Cross-chat tools: "A call
   * naming an offline host returns an error to the calling agent, naming the
   * host, within the turn")? Production wires the roster the server pushes;
   * when unset, cross-host calls are refused as unsupported rather than
   * silently landing on this host.
   */
  isHostOnline?: (hostId: string) => boolean;
  /**
   * Spawn a chat on ANOTHER host: emits the `patch.spawn` frame and resolves
   * with that host's own `patch.spawn.response` (spec/03 § Cross-chat
   * tools). Rejects with a `RemoteSpawnError` when the target refused or never
   * answered — the tool call is part of a turn in progress, so it must resolve
   * to a real outcome. When unset the endpoint 503s: a cross-host spawn with
   * nothing to carry the answer back would be a silent success.
   */
  spawnOnRemoteHost?: (req: {
    host: string;
    sourceChatId: string;
    folder: string;
    model?: string;
    prompt?: string;
    preferredAccountId?: string;
  }) => Promise<{ chatId?: string }>;
  /**
   * The shared accounts, over the server link: list, and change order or
   * strategy. Backs `patch_list_accounts` and the CLI's `accounts` commands on
   * this host. Unset, those endpoints 503.
   */
  accountsRpc?: AccountsRpc;
  /**
   * One REST call to the server over the link, for the host's own CLI
   * (`/server-api`). Unset, that endpoint 503s.
   */
  serverApi?: ServerApiRpc;
  /**
   * The account's event stream over the link, for the host's own CLI
   * (`/server-events`, newline-delimited JSON). Unset, that endpoint 503s.
   */
  serverEvents?: Pick<ServerEventsClient, 'subscribe'>;
  /**
   * The accounts this host holds for the backend a model runs on (Claude
   * when no model is named), so `account` on a spawn can be a label.
   */
  heldAccounts?: (model: string | undefined) => Array<{ id: string; label: string }>;
  /**
   * The account-wide chat list, each entry naming the host it lives on
   * (spec/03 § Cross-chat tools). Only the server sees every host's chats,
   * so production wires an RPC to it.
   */
  listAccountChats?: (
    sourceChatId: string,
    archived?: 'only' | 'include',
  ) => Promise<Array<{ chatId: string; hostId: string } & Record<string, unknown>>>;
  /**
   * `patch_search_chats`: search every chat on the account, answered by the
   * server from its chat index and record.
   */
  searchAccountChats?: (
    sourceChatId: string,
    query: string,
    limit?: number,
  ) => Promise<{
    results: unknown[];
    truncated: boolean;
    chatsWithoutLog: number;
  }>;
  /**
   * `patch_activity` (spec/06 § Cross-chat toolset): the user's own messages
   * for `[since, until]`, gathered server-side from every host's chat logs
   * — there is no per-chat host to resolve (unlike peek/history/send_to).
   */
  getActivity?: (
    sourceChatId: string,
    since: number,
    until: number,
    messagesCursor?: number,
    limit?: number,
    includeSessions?: boolean,
    sessionsCursor?: number,
  ) => Promise<{
    messages: unknown[];
    messagesTruncated: boolean;
    nextMessagesCursor?: number;
    /** Present only when sessions were asked for. */
    chatSessions?: unknown[];
    sessionsTruncated?: boolean;
    nextSessionsCursor?: number;
  }>;
  /**
   * Whether this host runs the Manager. When it does not, a local copy of a
   * reserved special thread is stale (the Manager moved), so patch_send_to /
   * patch_stop addressed to one skip it and relay to the host that does run
   * it. Unset means "do not special-case".
   */
  runsManager?: () => boolean;
  /**
   * `patch_peek` (spec/03 § Cross-chat tools): the server's answer from its own
   * record and chat status, for a chat on any host, online or not. Rejects
   * with a `RemoteRelayError` when the server does not know the chat or
   * cannot be reached. Unset, the tool answers 503.
   */
  peekFromServer?: (req: {
    sourceChatId: string;
    targetChatId: string;
    limit?: number;
  }) => Promise<{ chat_state: unknown; events: unknown[]; truncated: boolean }>;
  /** `patch_history`'s sibling to `peekFromServer`, same contract. */
  historyFromServer?: (req: {
    sourceChatId: string;
    targetChatId: string;
    fromSeq?: number;
    limit?: number;
  }) => Promise<{ events: WireEvent[]; nextFromSeq?: number }>;
  /**
   * `patch_send_to`'s cross-host sibling. Resolves once the OWNING host has
   * acknowledged the message was queued into its chat — same NO FALLBACK
   * contract as the other two: a host that no longer has the chat, or
   * never did, answers with a real error rather than a queued-nowhere ok.
   */
  sendToRemoteChat?: (req: {
    sourceChatId: string;
    targetChatId: string;
    message: string;
    /** The id the message is delivered under, so its reply can be found by it. */
    localId: string;
    voicePrefix?: string;
    /** A visible caller brings the recipient into view; hidden automation does not. */
    revealTarget: boolean;
  }) => Promise<void>;
  /**
   * `patch_stop`'s cross-host sibling: resolves once the OWNING host has
   * stopped the chat, rejects with its real error otherwise.
   */
  stopRemoteChat?: (req: { sourceChatId: string; targetChatId: string }) => Promise<void>;
  /**
   * Backs `patch_artifact` (spec/14 § Artifacts): hands the page to the server,
   * which owns the public origin, and resolves with the URL it is served from.
   * Production wires `ArtifactPublisher.publish`; when unset the endpoint 503s.
   * NO FALLBACK — an unwired publisher is a config error, never a pretend URL.
   */
  publishArtifact?: PublishArtifact;
  /**
   * Backs `patch_pad_*` (spec/14 § Pads): create/update/reply/list over the
   * server link. Production wires `PadClient.request`; unset, the endpoint 503s.
   */
  padRequest?: PadRequest;
  /** Backs `patch_meeting_notes`: the chat agent changing its meeting's notes. Returns the chip label. Unset, the endpoint 503s. */
  meetingAgentEdit?: (chatId: string, edit: MeetingAgentNotesEdit) => string;
  /** Test hook for the rate limiter. */
  rateLimiter?: RateLimiter;
  /** Structured logger for tool-call accounting. */
  toolLogger?: (entry: {
    tool: string;
    callerChatId?: string;
    targetChatId?: string;
    durationMs: number;
    ok: boolean;
    err?: string;
  }) => void;
  /**
   * Sidecar hook (group 11): called when patch_notify is invoked. The host
   * mounts this to append broadcast log entries on the relevant special
   * thread (speakers).
   */
  onBroadcast?: (entry: {
    channel: 'push' | 'desktop' | 'speakers';
    message: string;
    sourceChatId: string;
  }) => void;
  /**
   * Invoked by POST /stop (spec/02-host.md Control IPC). Shuts the host
   * process down. When unset the endpoint 503s — the in-process test harness
   * has nothing to stop.
   */
  onShutdown?: () => void;
  /**
   * The host-scoped controls this host owns (spec/02 § Control IPC). The CLI's
   * default host is the host it runs on, so every host control must work
   * over this socket without a round trip through the server — the same
   * operations the `host.*` wire frames drive, reachable locally. Unwired →
   * those routes 503 rather than pretending the control does not exist.
   *
   * The four host controls the SERVER owns (mint a registration code, rename,
   * revoke) are deliberately absent: they are HTTP even when the CLI
   * runs on the host itself.
   */
  host?: {
    /** Same content as this host's `host.host` report. */
    describe: () => HostInfoEvent;
    folders: {
      snapshot: () => { roots: string[]; recent: string[] };
      add: (path: string) => void;
      remove: (path: string) => boolean;
    };
    backends: {
      list: () => HostBackend[];
      /** The shared accounts as this host sees them, with the usage it last read. */
      accounts: () => HostAccountEvent['accounts'];
    };
    /** This host's catalogue across its backends, with per-backend errors. */
    models: () => Promise<{
      models: { id: string; label: string; backend: string }[];
      errors?: { backend: string; message: string }[];
    }>;
    components: {
      install: (componentId: string) => void;
      remove: (componentId: string) => void;
    };
    /** This host's Claude Code settings.json and memory entries (spec/02 § Claude Code settings). */
    claudeSettings: {
      snapshot: () => { settingsJson: string; memories: ClaudeMemoryEntry[] };
      /** Replace settings.json. Throws InvalidSettingsJsonError, named. */
      set: (text: string) => void;
      /** Throws InvalidMemoryRefError / MemoryNotFoundError, named. */
      deleteMemory: (project: string, file: string) => void;
    };
    /** Apply an available host update (spec/02 § Self-update). */
    update: () => Promise<{ applied: boolean; message: string; deferred?: boolean }>;
  };
  /**
   * Live host→server link diagnostics + the spec/12 link-drop control
   * (spec/12 ## Host → server disconnect, ## Observability). Exposes
   * `/internal/diag/link` (GET status + offline-buffer occupancy) and
   * `/internal/diag/drop-link` (POST: drop the upstream socket while the host
   * stays alive, so outbound events buffer and reconnect fires). Wired to the
   * real `ServerLink` in production (index.ts); unset in the in-process control
   * smoke tests, where the routes 503. NOT a fallback — reports/acts on real
   * link state only.
   */
  serverLink?: {
    diagnostics: () => { online: boolean; bufferSize: number; bufferMaxPerChat: number };
    dropLink: () => boolean;
    /**
     * Push `count` synthetic outbound events for `chatId` into the offline
     * buffer via the real EventBuffer, exercising the spec/12 bounded-buffer
     * cap/drop/warn on the running host. Backs `/internal/diag/flood-buffer`
     * so D3-5 is observable live (an organic, rate-limited flood is infeasible
     * against the running app). Returns the post-push total buffer size.
     */
    floodBuffer: (chatId: string, count: number) => number;
  };
  /**
   * Speak a `patch_call` message into an app voice call that is already open,
   * returning false when none is (spec/07 § Agent-initiated voice). Unset in
   * the in-process control smoke tests, which run no audio server; production
   * always wires it.
   */
  interruptOpenCall?: (text: string) => boolean;
  /** Backs `patch_end_call`: hang up the open app call on a chat. Unset in smoke tests. */
  endOpenCall?: (chatId: string, goodbye?: string) => Promise<boolean>;
  /**
   * Agents can call you (Settings → Voice calls), from the last settings
   * snapshot. Off: `patch_call` rings nothing and says so. Unset reads as on.
   */
  agentsCanCall?: () => boolean;
}

const SendToBody = z
  .object({
    chatId: z.string().min(1),
    message: z.string().min(1),
    voicePrefix: z.string().optional(),
    /** Goal to arm on the recipient chat (spec/04 § Goals). Local recipients only. */
    goal: z.string().min(1).optional(),
    /** The sender has been told the target is archived and still wants to wake it. */
    confirmArchived: z.boolean().optional(),
    // Required, not optional: the MCP child always bakes this from its own
    // PATCH_CHAT_ID (packages/host/src/mcp.ts) — it is not an agent-supplied
    // tool argument, so an agent can't omit it, and nothing else in this
    // codebase calls this no-auth UDS endpoint. A request arriving without
    // one is a caller bypassing the MCP wrapper entirely; reject it loudly
    // (NO FALLBACK) instead of defaulting to an untraceable reveal.
    callerChatId: z.string().min(1),
    /**
     * Idempotency key — host dedupes on `(chatId, localId)`. When omitted
     * we synthesise via `crypto.randomUUID()` so retries from the MCP child
     * don't double-deliver. See group 10 BLOCKER B2.
     */
    localId: z.string().min(1).max(128).optional(),
  })
  .strict();

const EndCallBody = z
  .object({
    /** When omitted, the calling chat's call is ended. */
    chatId: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
    callerChatId: z.string().min(1),
  })
  .strict();

// spec/04 § Send back. The MCP child bakes both ids from PATCH_CHAT_ID /
// PATCH_BRANCH_ID — `patch_send_back` always self-targets the calling branch.
const SendBackBody = z
  .object({
    chatId: z.string().min(1),
    branchId: z.string().min(1),
  })
  .strict();

// spec/14 § Document editor, step 2 of 3. `path` is relative to the calling
// chat's own folder — the MCP child bakes `chatId` from PATCH_CHAT_ID, so
// these three always act on the calling chat, never another one.
const DocSuggestBody = z
  .object({
    chatId: z.string().min(1),
    path: z.string().min(1),
    find: z.string().min(1),
    replace: z.string(),
  })
  .strict();
const DocCommentBody = z
  .object({
    chatId: z.string().min(1),
    path: z.string().min(1),
    anchor: z.string(),
    text: z.string().min(1),
  })
  .strict();
const DocReplyBody = z
  .object({
    chatId: z.string().min(1),
    path: z.string().min(1),
    threadId: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

// Word import/export (spec/14 § Document editor, step 3 of 3).
const DocConvertBody = z.object({ chatId: z.string().min(1), path: z.string().min(1) }).strict();
const DocExportBody = z
  .object({
    chatId: z.string().min(1),
    path: z.string().min(1),
    format: z.enum(['docx', 'pdf', 'md']),
  })
  .strict();

function wakeSummary(rec: {
  fireAt: number;
  every?: number | undefined;
  notAfter?: number | undefined;
  message: string;
}) {
  return {
    fireAt: rec.fireAt,
    fireAtIso: new Date(rec.fireAt).toISOString(),
    ...(rec.every !== undefined ? { everyMs: rec.every } : {}),
    ...(rec.notAfter !== undefined ? { notAfterIso: new Date(rec.notAfter).toISOString() } : {}),
    message: rec.message,
  };
}

// spec/02 § Self-wake. The MCP child bakes `chatId` from PATCH_CHAT_ID, so a
// wake always self-targets the calling chat. `patch_loop` posts here too —
// same primitive, `every` is the one extra field that turns it into a loop
// (`02-host.md` § Self-wake) — there is no separate internal route for it.
const WakeBody = z
  .object({
    chatId: z.string().min(1),
    message: z.string().min(1),
    /** Relative delay ("10m", "1h30m", "90s", "PT10M", or seconds). */
    in: z.union([z.string(), z.number()]).optional(),
    /** Absolute fire time (ISO 8601). Exactly one of `in`/`at`/`every`-alone. */
    at: z.string().optional(),
    /**
     * Recurring interval (same duration grammar as `in`). Present = a loop:
     * the host re-arms on every fire instead of clearing (`patch_loop`).
     */
    every: z.union([z.string(), z.number()]).optional(),
    /** Optional validity cutoff (ISO 8601) — drop the wake if it fires past this. */
    notAfter: z.string().optional(),
  })
  .strict();

const WakeCancelBody = z.object({ chatId: z.string().min(1) }).strict();

// patch_goal_set / patch_goal_clear (spec/04 § Goals, spec/06 § Tools). The
// MCP child bakes `chatId` from PATCH_CHAT_ID, same as wake/watch — a tool
// call only ever sets its OWN chat's goal. `goal: null` clears it, mirroring
// `/goal`'s own bare-command-clears convention.
const GoalSetBody = z
  .object({
    chatId: z.string().min(1),
    goal: z.string().min(1).nullable(),
    then: z.array(z.string().min(1)).max(50).optional(),
    remindEvery: ReminderEvery.nullable().optional(),
    checkInEvery: ReminderEvery.nullable().optional(),
  })
  .strict();

// patch_goal_clear: the agent's claim for the goal judge to test, never a bare clear.
const GoalFinishBody = z
  .object({
    chatId: z.string().min(1),
    verdict: z.enum(['met', 'impossible']),
    reason: z.string().min(1),
  })
  .strict();

// patch_watch. The MCP child bakes `chatId` from PATCH_CHAT_ID, same as wake —
// a watch always belongs to the chat that started it.
const WatchStartBody = z
  .object({
    chatId: z.string().min(1),
    command: z.string().min(1),
    description: z.string().min(1),
    timeoutSec: z.number().int().positive(),
    checkInSec: z.number().int().positive().optional(),
    wakeOnMatch: z.string().min(1).optional(),
    rerunOnReboot: z.boolean().optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();

const WatchStopBody = z.object({ chatId: z.string().min(1) }).strict();

// patch_browser_* (spec/02 § Browser, spec/06 § Browser tools). `chatId` is
// baked from PATCH_CHAT_ID like watch/wake — carried through to the tab for a
// future "Browsing <site>" status row, not enforced against an existing chat
// (a browser tab isn't scoped to one chat's folder the way a watch is).
const BrowserOpenBody = z
  .object({
    chatId: z.string().min(1),
    url: z.string().min(1),
    profile: z.enum(['logged-in', 'logged-out']).optional(),
  })
  .strict();

const BrowserHandoffBody = z
  .object({
    chatId: z.string().min(1),
    tabId: z.string().min(1),
    reason: z.string().min(1),
    callbackPort: z.number().int().min(1).max(65535).optional(),
    timeoutSeconds: z.number().int().min(10).max(3600).optional(),
    share: z.boolean().optional(),
  })
  .strict();

const BrowserTabIdBody = z.object({ tabId: z.string().min(1) }).strict();

const BrowserMouseBody = z
  .object({
    chatId: z.string().min(1),
    tabId: z.string().min(1),
    action: z.enum(['click', 'double_click', 'right_click', 'move', 'drag', 'scroll']),
    x: z.number().optional(),
    y: z.number().optional(),
    toX: z.number().optional(),
    toY: z.number().optional(),
    scrollX: z.number().optional(),
    scrollY: z.number().optional(),
  })
  .strict();

const BrowserKeyBody = z
  .object({
    chatId: z.string().min(1),
    tabId: z.string().min(1),
    keys: z.array(z.string().min(1)).min(1),
  })
  .strict();

const BrowserClickBody = z.object({ tabId: z.string().min(1), ref: z.string().min(1) }).strict();

const BrowserTypeBody = z
  .object({
    tabId: z.string().min(1),
    ref: z.string().min(1),
    text: z.string(),
    submit: z.boolean().optional(),
  })
  .strict();

const BrowserFillFormBody = z
  .object({
    tabId: z.string().min(1),
    fields: z.array(z.object({ ref: z.string().min(1), value: z.string() })).min(1),
  })
  .strict();

const BrowserSelectBody = z
  .object({ tabId: z.string().min(1), ref: z.string().min(1), value: z.string() })
  .strict();

const BrowserUploadBody = z
  .object({
    tabId: z.string().min(1),
    ref: z.string().min(1).optional(),
    filePaths: z.array(z.string().min(1)).min(1),
  })
  .strict();

const BrowserReadBody = z
  .object({
    tabId: z.string().min(1),
    mode: z.enum(['snapshot', 'text', 'structured', 'accessibility']).optional(),
    ref: z.string().min(1).optional(),
    maxChars: z.number().int().min(100).max(500_000).optional(),
  })
  .strict();

const BrowserScreenshotBody = z
  .object({
    tabId: z.string().min(1),
    ref: z.string().min(1).optional(),
    fullPage: z.boolean().optional(),
  })
  .strict();

const BrowserNavigateBody = z
  .object({
    tabId: z.string().min(1),
    action: z.enum(['goto', 'back', 'forward', 'reload']),
    url: z.string().min(1).optional(),
  })
  .strict();

const BrowserWaitBody = z
  .object({
    tabId: z.string().min(1),
    text: z.string().min(1).optional(),
    textGone: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
    ref: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    networkIdle: z.boolean().optional(),
    ms: z.number().int().min(0).max(30_000).optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
  })
  .strict();

const BrowserTarget = {
  tabId: z.string().min(1),
  ref: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
};
const BrowserInteractBody = z.discriminatedUnion('action', [
  z.object({ ...BrowserTarget, action: z.literal('hover') }).strict(),
  z.object({ ...BrowserTarget, action: z.literal('scroll_to') }).strict(),
  z
    .object({
      ...BrowserTarget,
      action: z.literal('drag'),
      toRef: z.string().min(1).optional(),
      toSelector: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...BrowserTarget,
      action: z.literal('press'),
      keys: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      ...BrowserTarget,
      action: z.literal('select_text'),
      text: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ tabId: z.string().min(1), action: z.literal('copy') }).strict(),
  z.object({ tabId: z.string().min(1), action: z.literal('paste') }).strict(),
  z.object({ tabId: z.string().min(1), action: z.literal('clipboard_read') }).strict(),
  z
    .object({ tabId: z.string().min(1), action: z.literal('clipboard_write'), text: z.string() })
    .strict(),
]);

const BrowserDialogBody = z
  .object({
    tabId: z.string().min(1),
    accept: z.boolean().optional(),
    promptText: z.string().optional(),
  })
  .strict();

const BrowserDownloadsBody = z
  .object({
    tabId: z.string().min(1).optional(),
    waitSeconds: z.number().int().min(0).max(120).optional(),
  })
  .strict();

const BrowserCookie = z.record(z.unknown());
const BrowserOrigins = z.array(
  z
    .object({
      origin: z.string().min(1),
      localStorage: z.array(z.object({ name: z.string(), value: z.string() }).strict()),
    })
    .strict(),
);
const BrowserStateBody = z.discriminatedUnion('action', [
  z
    .object({
      tabId: z.string().min(1),
      action: z.literal('get'),
      domain: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      tabId: z.string().min(1),
      action: z.literal('set'),
      cookies: z.array(BrowserCookie).optional(),
      origins: BrowserOrigins.optional(),
      localStorage: z.record(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      tabId: z.string().min(1),
      action: z.literal('save'),
      path: z.string().min(1),
      domain: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({ tabId: z.string().min(1), action: z.literal('load'), path: z.string().min(1) })
    .strict(),
  z
    .object({
      tabId: z.string().min(1),
      action: z.literal('clear'),
      cookies: z.boolean().optional(),
      localStorage: z.boolean().optional(),
    })
    .strict(),
]);

const BrowserEvalBody = z
  .object({
    tabId: z.string().min(1),
    expression: z.string().min(1),
    frameUrl: z.string().min(1).optional(),
  })
  .strict();

const BrowserConsoleBody = z
  .object({
    tabId: z.string().min(1),
    level: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    clear: z.boolean().optional(),
  })
  .strict();

const BrowserNetworkBody = z
  .object({
    tabId: z.string().min(1),
    urlContains: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    clear: z.boolean().optional(),
    bodyOf: z.number().int().min(1).optional(),
  })
  .strict();

const BrowserViewportBody = z
  .object({
    tabId: z.string().min(1),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    device: z.string().min(1).optional(),
    reset: z.boolean().optional(),
  })
  .strict();

/** The one error shape every `/internal/browser/*` route maps the same way. */
function sendBrowserError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof BrowserNotInstalledError || err instanceof AppBrowserUnavailableError) {
    return reply.code(503).send({ error: err.code, message: err.message });
  }
  if (err instanceof TabNotFoundError || err instanceof RefNotFoundError) {
    return reply.code(404).send({ error: err.code, message: err.message });
  }
  if (
    err instanceof TabInHandoffError ||
    err instanceof UserDrivingError ||
    err instanceof UserHandedBackError
  ) {
    return reply.code(409).send({ error: err.code, message: err.message });
  }
  if (err instanceof BrowserStoppedError) {
    return reply.code(409).send({ error: err.code, message: err.message });
  }
  return reply
    .code(400)
    .send({ error: 'browser_error', message: err instanceof Error ? err.message : String(err) });
}

// patch_delegate. `chatId` (baked from PATCH_CHAT_ID, same as watch/wake) is
// the parent — the delegate is always created under the chat that asked.
const DelegateStartBody = z
  .object({
    chatId: z.string().min(1),
    prompt: z.string().min(1),
    title: z.string().min(1).max(60).optional(),
    model: z.string().min(1).optional(),
    folder: z.string().min(1).optional(),
    account: z.string().min(1).optional(),
    disallowedTools: z.array(z.string().min(1)).optional(),
    wait: z.boolean().optional(),
  })
  .strict();

const DelegateSendBody = z
  .object({
    chatId: z.string().min(1),
    id: z.string().min(1),
    message: z.string().min(1),
    wait: z.boolean().optional(),
  })
  .strict();

const DelegateListQuery = z.object({ chatId: z.string().min(1) }).strict();

const DelegateStopBody = z.object({ chatId: z.string().min(1), id: z.string().min(1) }).strict();

const SpawnBody = z
  .object({
    folder: z.string().min(1),
    /**
     * The host to create the chat on (spec/03 § Cross-chat tools). Omitted
     * means THIS host. Naming another host relays the spawn to it through
     * the server.
     */
    host: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    /** Goal to arm on the new chat (spec/04 § Goals). Same-host spawns only. */
    goal: z.string().min(1).optional(),
    callerChatId: z.string().min(1).optional(),
    /** The stored account the chat starts on: its id or its label. Refused if not held. */
    account: z.string().min(1).optional(),
    /** Spawn into Hidden (spec/04 § Hidden) — CLI `--hidden`. Same-machine spawns only. */
    hidden: z.boolean().optional(),
    /** SDK model override (CLI `--model` pass-through; spec/13). */
    model: z.string().min(1).optional(),
    /** SDK permission mode (CLI `--dangerously-skip-permissions`; spec/13). */
    permissionMode: z
      .enum(['auto', 'default', 'acceptEdits', 'bypassPermissions', 'plan'])
      .optional(),
  })
  .strict();

const StopParams = z.object({ id: z.string().min(1) }).strict();

const ServerApiBody = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().min(1),
    body: z.unknown().optional(),
  })
  .strict();
const AccountsBackendParams = z.object({ backendId: z.enum(BACKEND_IDS) }).strict();
const AccountsOrderBody = z.object({ accountIds: z.array(z.string().min(1)).min(1) }).strict();
const AccountsStrategyBody = z
  .object({ strategy: z.enum(['priority', 'round-robin', 'soonest-reset', 'least-used']) })
  .strict();

const ListChatsQuery = z
  .object({
    archived: z.enum(['only', 'include']).optional(),
    /** The calling chat, when there is one (the CLI in a terminal has none). */
    callerChatId: z.string().min(1).optional(),
  })
  .strict();

const SearchChatsQuery = z
  .object({
    query: z.string().min(1),
    limit: z.coerce.number().int().positive().max(100).optional(),
    callerChatId: z.string().min(1),
  })
  .strict();

// patch_activity: since/until are required — the window is always explicit,
// never a silent "whatever the server feels like". The server clamps the
// span and page size (cross-host.ts); this schema only validates shape.
const ActivityQuery = z
  .object({
    since: z.coerce.number().int().nonnegative(),
    until: z.coerce.number().int().nonnegative(),
    messagesCursor: z.coerce.number().int().nonnegative().optional(),
    /** Also return chat dwell sessions; a `sessionsCursor` implies it. */
    includeSessions: z
      .enum(['true', 'false', '1', '0'])
      .transform((v) => v === 'true' || v === '1')
      .optional(),
    sessionsCursor: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().optional(),
    /** The calling chat — correlates the account-wide activity RPC to the server. */
    callerChatId: z.string().min(1),
  })
  .strict();

// The notify fanout is fire-and-forget (the host emits the wire event and
// returns before the server attempts delivery), so an over-length message
// would otherwise be silently dropped server-side with only an
// undelivered.jsonl trace the caller never sees (C3-d2). Enforce a cap
// UP-FRONT here so the caller gets an actionable 4xx instead — desktop/push
// notification bodies this long are never useful anyway.
const NOTIFY_MESSAGE_MAX = 4096;
/** A quick-reply button's text — short enough to read on a notification. */
const NOTIFY_QUICK_REPLY_MAX = 40;

const AskHumanDoneBody = z.object({ callerChatId: z.string().min(1) }).strict();

const AskHumanBody = z
  .object({
    task: z.string().min(1),
    why: z.string().min(1).optional(),
    resumeAt: z.number().int().positive().optional(),
    callerChatId: z.string().min(1),
  })
  .strict();

const ReportBody = z
  .object({
    summary: z.string().min(1).max(200),
    callerChatId: z.string().min(1),
  })
  .strict();

const NotifyBody = z
  .object({
    // Absent for an ordinary notify: the agent says what and how much, and the
    // server routes it by where the user actually is. Still accepted from
    // `patch_speak` and the special threads, which are naming an act ("say this
    // out loud") rather than choosing a delivery.
    channel: z.enum(['push', 'desktop', 'speakers']).optional(),
    message: z
      .string()
      .min(1)
      .max(
        NOTIFY_MESSAGE_MAX,
        `message exceeds the ${NOTIFY_MESSAGE_MAX}-character limit; split or shorten it`,
      ),
    priority: z.enum(['silent', 'normal', 'urgent']).optional(),
    deviceId: z.string().min(1).optional(),
    deepLink: z.string().min(1).max(2048).optional(),
    /**
     * spec/09 § Notification actions, spec/06 § `patch_notify` — up to 2 short
     * strings, each rendered as a button on the notification that sends that
     * text as the user's reply when tapped.
     */
    quickReplies: z.array(z.string().min(1).max(NOTIFY_QUICK_REPLY_MAX)).max(2).optional(),
    callerChatId: z.string().min(1),
  })
  .strict();

const CallBody = z
  .object({
    /** When omitted, the calling chat is the call target. */
    chatId: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
    /** Accepted for older callers; voice devices are not rung for calls. */
    deviceId: z.string().min(1).optional(),
    callerChatId: z.string().min(1),
  })
  .strict();

// patch_artifact (spec/14 § Artifacts). `path` is chat-folder-relative; the
// resolver rejects escapes and non-HTML files.
const PadBody = z
  .object({
    op: z.enum(['create', 'update', 'reply', 'list', 'collect', 'capture']),
    surface: z.enum(['web', 'phone']).optional(),
    callerChatId: z.string().min(1),
    /** Chat-folder-relative folder holding the Pad's screens (create/update). */
    dir: z.string().min(1).optional(),
    padId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    app: z.string().min(1).optional(),
    device: z.enum(['desktop', 'phone']).optional(),
    text: z.string().min(1).optional(),
  })
  .strict();

const ArtifactBody = z
  .object({
    path: z.string().min(1),
    title: z.string().min(1).optional(),
    callerChatId: z.string().min(1),
  })
  .strict();

// view_file (spec/14 § Tool calls). `file_path` may be absolute or
// chat-folder-relative; the resolver rejects anything outside the chat folder
// and the chat's own config dir.
const ViewFileBody = z
  .object({
    file_path: z.string().min(1),
    callerChatId: z.string().min(1),
  })
  .strict();

// link_file: a pointer to a file anywhere on this host's disk. Unlike view_file
// nothing is read or published, so there is no chat-folder boundary: the card
// only offers to open it on the machine the host runs on.
const LinkFileBody = z
  .object({
    file_path: z.string().min(1),
    callerChatId: z.string().min(1),
  })
  .strict();

// patch_history: the 200 hard cap is a CLAMP, not a rejection (mirrors the
// job-runs route). A caller asking for limit:5000 must get the first 200
// events, not a 400.
const HistoryQuery = z
  .object({
    fromSeq: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().optional(),
    /** The calling chat, named on the request the server answers. */
    callerChatId: z.string().min(1).optional(),
  })
  .strict();

/**
 * The single 4xx/5xx envelope every host control-surface error uses
 * (spec/02-host.md Control IPC): always `{ error, message }` — a stable
 * machine-readable `error` code plus a human `message`. NO divergent shapes:
 * zod failures, fastify body-parse failures, rate-limit, and not-found all
 * funnel through this so callers can parse one shape.
 */
interface ErrorEnvelope {
  error: string;
  message: string;
}

const NOT_DELIVERED_SNOOZED = {
  ok: true,
  delivered: false,
  reason: 'chat is snoozed',
} as const;

function isSnoozedNow(state: { snoozedUntil: number | null } | undefined): boolean {
  return state?.snoozedUntil != null && state.snoozedUntil > Date.now();
}

export async function buildControl(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const isForeignSpecialThread = (chatId: string): boolean =>
    opts.runsManager !== undefined && !opts.runsManager() && isReservedSpecialThread(chatId);
  // patch_send_to's delivery: the one shared with the Manager call's send_to_chat.
  const deliverToChat =
    opts.daemon &&
    createChatDelivery({
      daemon: opts.daemon,
      ...(opts.runsManager ? { runsManager: opts.runsManager } : {}),
      ...(opts.sendToRemoteChat ? { sendToRemoteChat: opts.sendToRemoteChat } : {}),
      ...(opts.emitWire ? { emitWire: opts.emitWire } : {}),
    });
  // forceCloseConnections: the host's own MCP servers and the CLI keep
  // connections open, some on requests that wait for the user. `close()` must
  // end them, not wait for them (spec/02 § Restarting the host).
  const app = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true });

  // Normalize fastify's OWN errors (e.g. a malformed/empty JSON body, which
  // fastify otherwise emits as {statusCode,code,error,message}) into the single
  // {error, message} envelope. Without this, body-parse 400s would be a
  // divergent shape from our zod/rate-limit/not-found 400s.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const statusCode = err.statusCode ?? 500;
    // Map fastify's host code to our snake_case `error` slug; fall back to a
    // generic slug derived from the status class.
    let slug: string;
    if (
      err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ) {
      slug = 'invalid_json';
    } else if (statusCode >= 500) {
      slug = 'internal_error';
    } else {
      slug = 'bad_request';
    }
    const body: ErrorEnvelope = { error: slug, message: err.message };
    reply.code(statusCode).send(body);
  });

  // Unknown route → the same envelope (was fastify's default {statusCode,...}).
  app.setNotFoundHandler((req, reply) => {
    const body: ErrorEnvelope = {
      error: 'not_found',
      message: `route not found: ${req.method} ${req.url}`,
    };
    reply.code(404).send(body);
  });
  // Backwards-compatible decoration: if no host, expose an empty map so
  // legacy callers (early-boot smoke tests) don't crash.
  const stateMap = opts.daemon?.chatState ?? new ChatStateMap();
  app.decorate('chatState', stateMap);

  // 60 calls per minute per caller — applied to mutating cross-chat tools
  // (send_to / spawn / stop). Read-only tools (peek/history/list/job_list)
  // skip this gate.
  const limiter = opts.rateLimiter ?? new RateLimiter({ windowMs: 60_000, max: 60 });
  // patch_send_to with no caller-supplied localId gets a fresh random one per
  // call, so a retried tool call (client timeout, transport replay) was
  // delivered to the recipient again and again. Remember what each caller just
  // sent each target and answer an identical repeat inside the window without
  // delivering it a second time.
  const SEND_TO_DEDUPE_MS = 30_000;
  const recentSendTos = new Map<string, number>();
  const toolLog = opts.toolLogger ?? ((): void => undefined);

  // Centralized 429: emit a Retry-After header (seconds until a slot frees) plus
  // the X-RateLimit-* trio so the caller knows the window and when to retry,
  // and reply with the standard {error, message} envelope (spec/02 Control IPC,
  // C3-d3 / C3-d4). NO bare {error:'rate_limited'}.
  function sendRateLimited(reply: import('fastify').FastifyReply, key: string): void {
    const retryAfter = limiter.retryAfterSeconds(key);
    reply
      .header('Retry-After', String(retryAfter))
      .header('X-RateLimit-Limit', String(limiter.maxPerWindow))
      .header('X-RateLimit-Remaining', '0')
      .header('X-RateLimit-Reset', String(retryAfter))
      .code(429)
      .send({
        error: 'rate_limited',
        message: `rate limit exceeded (${limiter.maxPerWindow} calls / ${limiter.windowSeconds}s); retry after ${retryAfter}s`,
      } satisfies ErrorEnvelope);
  }

  app.get('/healthz', async (): Promise<HealthzResponse> => {
    return { ok: true, version: VERSION, gitSha: GIT_SHA };
  });

  function checkAuth(req: FastifyRequest): { ok: true } | { ok: false; reason: string } {
    if (!opts.localKey) return { ok: false, reason: 'local-key not configured' };
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return { ok: false, reason: 'missing bearer' };
    }
    const provided = header.slice('Bearer '.length).trim();
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(opts.localKey).digest();
    return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'bad key' };
  }

  /**
   * Gate the whole socket, not just the CLI half.
   *
   * `/internal/*` is the MCP child's surface — `patch_spawn`, `patch_notify`,
   * `patch_job_create`, `patch_wake_me` — and those cause turns and side
   * effects with the host user's full authority (spec/10 § The authority of a
   * turn). They were reachable by any local process that could open the
   * socket, while the read-only `/chats` listing next to them was gated. Auth
   * is the same for every caller of the socket (spec/02 § Control IPC), so it
   * is applied in one place here rather than route by route, where the next
   * route added would be the next one forgotten.
   *
   * `/healthz` stays open: it carries no authority and is what a service
   * manager probes.
   */
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz' || req.url.startsWith('/healthz?')) return;
    const auth = checkAuth(req);
    if (!auth.ok) {
      // An audit line for every refusal, with the reason — a rejected call
      // must be readable back, not silent.
      req.log.warn(
        { url: req.url, method: req.method, reason: auth.reason },
        'control-ipc: refused unauthenticated call',
      );
      return reply.code(401).send({ error: auth.reason });
    }
  });

  // --- Local CLI endpoints ---------------------------------------------------

  // GET /chats/unreadable — chats this host could not load at all (their
  // meta.json failed to read or parse), for `patch doctor`. Only this host can
  // know, so it is answered here. It is NOT a chat listing: every list of chats
  // and their status comes from the server (`/internal/chats`, spec/12 § Chat
  // status), never from this host's own view.
  app.get('/chats/unreadable', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
    return { unreadable: opts.daemon.unreadableChats() };
  });

  // GET /chats/folders?path=<partial> — host-mediated folder discovery for
  // the CLI's interactive picker and `--folder` tab-completion (spec/13: "Lists
  // recent folders on the host machine"; "Tab-completion for --folder is
  // host-mediated — the CLI asks the host what's there"). The listing is
  // sourced from THIS (host) box's filesystem, independent of where the CLI
  // runs. Returns:
  //   recents     — distinct folders of the host's known chats (most-recent
  //                 first), the picker's default list.
  //   completions — when `path` is given, the immediate subdirectories of the
  //                 host-side directory that start with the partial leaf, as
  //                 absolute paths (the candidate set for shell completion).
  app.get<{ Querystring: { path?: string } }>('/chats/folders', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });

    // Recent folders from the host's chat roster, most-recent first, deduped.
    // Excludes patch_delegate subagents (spec/02 § Native subagent dispatch).
    const chats = opts.daemon.listAll().filter((c) => !c.subagent) as Array<{
      folder?: string;
      lastUpdated?: number;
    }>;
    const seen = new Set<string>();
    const recents: string[] = [];
    for (const c of [...chats].sort((a, b) => (b.lastUpdated ?? 0) - (a.lastUpdated ?? 0))) {
      if (c.folder && !seen.has(c.folder)) {
        seen.add(c.folder);
        recents.push(c.folder);
      }
    }

    let completions: string[] = [];
    const partial = req.query?.path;
    if (partial !== undefined && partial.length > 0) {
      // Split into the parent directory to scan and the leaf prefix to match.
      const abs = resolve(expandHome(partial));
      const endsWithSep = partial.endsWith('/');
      const dirToScan = endsWithSep ? abs : resolve(abs, '..');
      const leaf = endsWithSep ? '' : abs.slice(abs.lastIndexOf(sep) + 1);
      try {
        completions = readdirSync(dirToScan, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name.startsWith(leaf))
          .map((d) => join(dirToScan, d.name));
      } catch {
        // Non-existent parent dir → no candidates (NOT an error; the user may
        // still be typing). The folder-existence guard lives on spawn.
        completions = [];
      }
    }

    return { recents, completions };
  });

  // `:id` accepts the full chatId or a unique prefix of one (spec/17-cli.md:
  // "`<id>` accepts the full ULID or a unique prefix") — resolved via
  // `chatState.resolve` before use on every route below.
  // `patch chats get`: the chat's entry and status as the server holds them
  // (read like patch_peek, only the chat_state kept), for a chat on any host.
  // A prefix of one of this host's own chats is resolved here first.
  app.get<{ Params: { id: string } }>('/chats/:id', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
    if (!opts.peekFromServer) {
      return reply
        .code(503)
        .send({ error: 'unavailable', message: 'patch chats get: no Patch server to read from' });
    }
    const chatId = opts.daemon.chatState.resolve(req.params.id)?.chatId ?? req.params.id;
    try {
      const remote = await opts.peekFromServer({
        sourceChatId: 'cli',
        targetChatId: chatId,
        limit: 1,
      });
      return remote.chat_state;
    } catch (err) {
      const code = err instanceof RemoteRelayError ? err.code : 'sdk_error';
      return reply.code(code === 'chat_not_found' ? 404 : 502).send({
        error: code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post<{ Params: { id: string } }>('/chats/:id/stop', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
    const state = opts.daemon.chatState.resolve(req.params.id);
    if (!state) {
      // Not on this host: the owning one may be elsewhere. A full id only —
      // a prefix cannot be resolved without the owner's chat list.
      if (opts.stopRemoteChat) {
        try {
          await opts.stopRemoteChat({ sourceChatId: 'cli', targetChatId: req.params.id });
          return { ok: true };
        } catch (err) {
          const code = err instanceof RemoteRelayError ? err.code : 'sdk_error';
          return reply.code(code === 'chat_not_found' ? 404 : 502).send({
            error: code === 'chat_not_found' ? 'not found' : code,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return reply.code(404).send({ error: 'not found' });
    }
    if (opts.daemon.refuseUnlessCapable(state.chatId, 'interrupt')) {
      return reply.code(409).send(INTERRUPT_UNSUPPORTED);
    }
    await opts.daemon.stopChat(state.chatId);
    return { ok: true };
  });

  // POST /chats/:id/resume-now — stop waiting out a usage-limit pause and run
  // the parked turn now (same effect as the card's button, spec/10 § Usage).
  // `resumed: false` means nothing was parked, so the caller can say so.
  app.post<{ Params: { id: string } }>('/chats/:id/resume-now', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
    const state = opts.daemon.chatState.resolve(req.params.id);
    if (!state) return reply.code(404).send({ error: 'not found' });
    const resumed = opts.daemon.resumeRateLimitedNow(state.chatId);
    return { ok: true, resumed };
  });

  // POST /chats/:id/archive — archive/unarchive a chat over the local UDS.
  // spec/17-cli.md: `patch chats archive <id>` is a primitive that MUST work on
  // the default local transport (the host is the one backend). `setArchived`
  // mutates host state + emits chat.state, which propagates to the server
  // registry — same effect as the server's REST archive route. Body is
  // optional `{archived?: boolean}` (defaults to true).
  app.post<{ Params: { id: string }; Body: { archived?: boolean } | undefined }>(
    '/chats/:id/archive',
    async (req, reply) => {
      const auth = checkAuth(req);
      if (!auth.ok) return reply.code(401).send({ error: auth.reason });
      if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
      const state = opts.daemon.chatState.resolve(req.params.id);
      if (!state) {
        // Not on this machine: the server knows the owner and forwards. A full
        // id only — a prefix cannot be resolved without the owner's chat list.
        if (opts.serverApi) {
          try {
            const ans = await opts.serverApi({
              method: 'POST',
              path: `/api/chats/${encodeURIComponent(req.params.id)}/archive`,
              body: { archived: req.body?.archived ?? true },
            });
            return reply.code(ans.status).send(ans.body ?? '');
          } catch (err) {
            const code = err instanceof AccountsRpcError ? err.code : 'internal';
            return reply
              .code(code === 'link_offline' ? 503 : code === 'timeout' ? 504 : 500)
              .send({ error: code, message: err instanceof Error ? err.message : String(err) });
          }
        }
        return reply.code(404).send({ error: 'not found' });
      }
      const archived = req.body?.archived ?? true;
      try {
        await opts.daemon.setArchived(state.chatId, archived);
      } catch (err) {
        if (err instanceof ChatNotFoundError) {
          return reply.code(404).send({ error: 'not found' });
        }
        throw err;
      }
      return { ok: true };
    },
  );

  // POST /chats/:id/hide — hide/show a chat over the local UDS (spec/04 § Hidden).
  // The server's REST hide route is not relayable through a host, so a CLI on a
  // host needs this one. Body `{hidden: boolean}`.
  // A refused change (special thread, not active) is a 409
  // carrying the host's reason — NO FALLBACK.
  app.post<{
    Params: { id: string };
    Body: { hidden?: unknown } | undefined;
  }>('/chats/:id/hide', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
    const hidden = req.body?.hidden;
    if (typeof hidden !== 'boolean') {
      return reply.code(400).send({ error: 'hidden (boolean) is required' });
    }
    const state = opts.daemon.chatState.resolve(req.params.id);
    if (!state) return reply.code(404).send({ error: 'not found' });
    try {
      await opts.daemon.setHidden(state.chatId, hidden);
    } catch (err) {
      if (err instanceof ChatNotFoundError) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply
        .code(409)
        .send({ error: 'hide_refused', message: err instanceof Error ? err.message : String(err) });
    }
    return { ok: true };
  });

  // POST /chats/:id/model — run an existing chat on another model from its
  // NEXT turn (spec/04 § Model). Body `{model: string}`, required. A refused
  // change (unknown model, no catalogue) is a 400 with the host's error code
  // and leaves the chat on the model it had — NO FALLBACK.
  app.post<{ Params: { id: string }; Body: { model?: unknown } | undefined }>(
    '/chats/:id/model',
    async (req, reply) => {
      const auth = checkAuth(req);
      if (!auth.ok) return reply.code(401).send({ error: auth.reason });
      if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
      const model = req.body?.model;
      if (typeof model !== 'string' || model.length === 0) {
        return reply.code(400).send({ error: 'model is required' });
      }
      const state = opts.daemon.chatState.resolve(req.params.id);
      if (!state) return reply.code(404).send({ error: 'not found' });
      try {
        await opts.daemon.setChatModel(state.chatId, model);
      } catch (err) {
        if (err instanceof ChatNotFoundError) {
          return reply.code(404).send({ error: 'not found' });
        }
        const code = (err as { code?: string }).code;
        if (code === 'unknown_model' || code === 'no_model_catalogue') {
          return reply.code(400).send({ error: code, message: (err as Error).message });
        }
        throw err;
      }
      return { ok: true, chatId: state.chatId, model };
    },
  );

  // POST /chats/:id/disable — turn a special thread on/off over the local UDS.
  // spec/06 § Disabled: the real "off" switch for Manager/Speakers,
  // since `setArchived` refuses them. Body `{disabled?: boolean}` (defaults
  // to true, matching /archive's default-to-true shape).
  app.post<{ Params: { id: string }; Body: { disabled?: boolean } | undefined }>(
    '/chats/:id/disable',
    async (req, reply) => {
      const auth = checkAuth(req);
      if (!auth.ok) return reply.code(401).send({ error: auth.reason });
      if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
      const state = opts.daemon.chatState.resolve(req.params.id);
      if (!state) return reply.code(404).send({ error: 'not found' });
      const disabled = req.body?.disabled ?? true;
      try {
        await opts.daemon.setDisabled(state.chatId, disabled);
      } catch (err) {
        if (err instanceof ChatNotFoundError) {
          return reply.code(404).send({ error: 'not found' });
        }
        throw err;
      }
      return { ok: true };
    },
  );

  // POST /chats/:id/snooze — snooze/unsnooze a chat over the local UDS
  // (spec/04 § Snooze). Body `{snoozedUntil: number | null}` — an ABSOLUTE ms
  // epoch, or null to unsnooze. A past timestamp is a 400 (NO FALLBACK): the
  // caller is never silently given "now".
  app.post<{ Params: { id: string }; Body: { snoozedUntil?: number | null } | undefined }>(
    '/chats/:id/snooze',
    async (req, reply) => {
      const auth = checkAuth(req);
      if (!auth.ok) return reply.code(401).send({ error: auth.reason });
      if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
      const snoozedUntil = req.body?.snoozedUntil;
      if (snoozedUntil === undefined) {
        return reply
          .code(400)
          .send({ error: 'snoozedUntil is required (number ms epoch or null)' });
      }
      const state = opts.daemon.chatState.resolve(req.params.id);
      if (!state) return reply.code(404).send({ error: 'not found' });
      try {
        await opts.daemon.setSnoozed(state.chatId, snoozedUntil);
      } catch (err) {
        if (err instanceof ChatNotFoundError) {
          return reply.code(404).send({ error: 'not found' });
        }
        return reply.code(400).send({ error: (err as Error).message });
      }
      return { ok: true };
    },
  );

  // --- Spec/02-host.md Control IPC table ----------------------------------
  // The canonical local-CLI control surface (`patch <subcommand>` on the
  // host box). Same auth gate as /chats/*. These are the spec-named
  // endpoints; /chats/* above is the richer convenience shape the TUI uses.

  // GET /list — active chats.
  app.get('/list', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
    return { chats: opts.daemon.listAll().filter((c) => !c.subagent) };
  });

  // POST /spawn-chat — spawn a new chat in a folder.
  app.post('/spawn-chat', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
    const parsed = SpawnBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    }
    let preferredAccountId: string | undefined;
    if (parsed.data.account !== undefined) {
      try {
        preferredAccountId = resolveSpawnAccount(parsed.data.account, parsed.data.model);
      } catch (err) {
        return reply.code(400).send({
          error: 'account_not_found',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const spawnReq: SpawnChatOptions = {
      folder: parsed.data.folder,
      ...(preferredAccountId !== undefined ? { preferredAccountId } : {}),
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.prompt !== undefined ? { prompt: parsed.data.prompt } : {}),
      ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
      ...(parsed.data.permissionMode !== undefined
        ? { permissionMode: parsed.data.permissionMode }
        : {}),
    };
    try {
      const chatId = await opts.daemon.spawnChat(spawnReq);
      return { chatId };
    } catch (err) {
      if (err instanceof FolderNotFoundError) {
        return reply.code(400).send({ error: 'folder_not_found', message: err.message });
      }
      // spec/04 § Spawn — this host has never read a model catalogue, so a
      // spawn naming no model has nothing to take. Said out loud with the code
      // the wire contract names; NEVER a 500, and never a guessed model id.
      if (err instanceof NoModelCatalogueError) {
        return reply.code(409).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // POST /stop-chat — stop a tracked chat ({chatId} body).
  app.post('/stop-chat', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
    const parsed = z
      .object({ chatId: z.string().min(1) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    }
    try {
      if (opts.daemon.refuseUnlessCapable(parsed.data.chatId, 'interrupt')) {
        return reply.code(409).send(INTERRUPT_UNSUPPORTED);
      }
      await opts.daemon.stopChat(parsed.data.chatId);
      return { ok: true };
    } catch (err) {
      if (err instanceof ChatNotFoundError) {
        return reply.code(404).send({ error: 'chat_not_found', message: err.message });
      }
      throw err;
    }
  });

  // POST /clean — remove meta.json entries for chats Claude Code has lost
  // (spec/02-host.md ## CLI: `patch host clean`). Auth-gated like the
  // other local-CLI control endpoints. Returns { removed: chatId[] }.
  app.post('/clean', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.daemon) return reply.code(503).send({ error: 'host not initialised' });
    return opts.daemon.cleanStaleChats();
  });

  // --- Host-scoped controls (spec/02 § Control IPC) -------------------------
  // One endpoint per host-scoped wire frame this host owns, so `patch` run on
  // the host itself drives them without a round trip through the server.

  /** Shared gate: authed, and the host controls actually wired. */
  /** An `account` as typed (id or label) → the stored account id on this host. */
  const resolveSpawnAccount = (account: string, model: string | undefined): string => {
    if (!opts.heldAccounts) {
      throw new AccountRefError('this host has no account store, so it cannot pick an account');
    }
    return resolveAccountRef(account, opts.heldAccounts(model));
  };

  const hostGate = (
    req: FastifyRequest,
    reply: FastifyReply,
  ): NonNullable<BuildOptions['host']> | undefined => {
    const auth = checkAuth(req);
    if (!auth.ok) {
      void reply.code(401).send({ error: auth.reason });
      return undefined;
    }
    if (!opts.host) {
      void reply.code(503).send({ error: 'host controls not wired' });
      return undefined;
    }
    return opts.host;
  };

  // GET /host — this host's self-description.
  app.get('/folder-access', async () => probeFolderAccess());

  app.get('/host', async (req, reply) => {
    const host = hostGate(req, reply);
    if (!host) return;
    return host.describe();
  });

  // GET /folders — this host's folder registry.
  app.get('/folders', async (req, reply) => {
    const host = hostGate(req, reply);
    if (!host) return;
    return host.folders.snapshot();
  });

  // POST /folders/add — designate a project root.
  app.post('/folders/add', async (req, reply) => {
    const host = hostGate(req, reply);
    if (!host) return;
    const parsed = z
      .object({ path: z.string().min(1) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    }
    try {
      host.folders.add(parsed.data.path);
    } catch (err) {
      // A root that is not a directory on THIS host would publish a picker
      // entry whose every spawn fails. Refused with the offending value named.
      return reply.code(400).send({ error: 'folder_invalid', message: (err as Error).message });
    }
    return { ok: true, ...host.folders.snapshot() };
  });

  // POST /folders/remove — drop a designated project root.
  app.post('/folders/remove', async (req, reply) => {
    const host = hostGate(req, reply);
    if (!host) return;
    const parsed = z
      .object({ path: z.string().min(1) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    }
    const removed = host.folders.remove(parsed.data.path);
    if (!removed) {
      return reply.code(404).send({
        error: 'folder_not_registered',
        message: `not a project root: ${parsed.data.path}`,
      });
    }
    return { ok: true, ...host.folders.snapshot() };
  });

  // GET /claude-settings — this host's Claude Code settings.json + memory entries.
  app.get('/claude-settings', async (req, reply) => {
    const host = hostGate(req, reply);
    if (!host) return;
    return host.claudeSettings.snapshot();
  });

  // POST /claude-settings — replace this host's settings.json (spec/02 §
  // Claude Code settings). Text that is not a JSON object is refused.
  app.post('/claude-settings', async (req, reply) => {
    const host = hostGate(req, reply);
    if (!host) return;
    const parsed = z.object({ text: z.string() }).strict().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    }
    try {
      host.claudeSettings.set(parsed.data.text);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: 'claude_settings_invalid', message: (err as Error).message });
    }
    return { ok: true, ...host.claudeSettings.snapshot() };
  });

  // POST /claude-settings/memory/delete — remove one memory entry.
  app.post('/claude-settings/memory/delete', async (req, reply) => {
    const host = hostGate(req, reply);
    if (!host) return;
    const parsed = z
      .object({ project: z.string().min(1), file: z.string().min(1) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    }
    try {
      host.claudeSettings.deleteMemory(parsed.data.project, parsed.data.file);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: 'claude_settings_invalid', message: (err as Error).message });
    }
    return { ok: true, ...host.claudeSettings.snapshot() };
  });

  // ---- shared accounts (over the server link) ----------------------------
  // `/accounts*` is the host's own CLI (local key); `/internal/accounts` is
  // the MCP child (`patch_list_accounts`). All go to the server, which owns the
  // order and strategy, so none needs a separate login.
  const accountsCall = async (
    reply: FastifyReply,
    req: Parameters<AccountsRpc>[0],
  ): Promise<unknown> => {
    if (!opts.accountsRpc) {
      return reply
        .code(503)
        .send({ error: 'accounts_unavailable', message: 'accounts are not wired on this host' });
    }
    try {
      return await opts.accountsRpc(req);
    } catch (err) {
      const code = err instanceof AccountsRpcError ? err.code : 'internal';
      const status = code === 'link_offline' ? 503 : code === 'timeout' ? 504 : 400;
      return reply.code(status).send({
        error: code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
  // The CLI's way to the server from this host: relayed over the link, so
  // it needs no credential of its own. The server decides what is relayable.
  app.post('/server-api', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.serverApi) {
      return reply.code(503).send({
        error: 'server_api_unavailable',
        message: 'the server link is not wired on this host',
      });
    }
    const parsed = ServerApiBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    try {
      const ans = await opts.serverApi(parsed.data);
      return reply.code(ans.status).send(ans.body ?? '');
    } catch (err) {
      const code = err instanceof AccountsRpcError ? err.code : 'internal';
      return reply
        .code(code === 'link_offline' ? 503 : code === 'timeout' ? 504 : 500)
        .send({ error: code, message: err instanceof Error ? err.message : String(err) });
    }
  });
  // `patch logs` on this host: the account's events, relayed over the link.
  app.get('/server-events', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.serverEvents) {
      return reply.code(503).send({
        error: 'server_events_unavailable',
        message: 'the server link is not wired on this host',
      });
    }
    const raw = reply.raw;
    let stop: (() => void) | null = null;
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      stop?.();
      raw.end();
    };
    try {
      stop = opts.serverEvents.subscribe({
        onEvent: (event) => {
          if (!ended) raw.write(JSON.stringify(event) + '\n');
        },
        onEnd: (reason) => {
          if (!ended) raw.write(JSON.stringify({ type: 'stream.error', message: reason }) + '\n');
          stop = null;
          finish();
        },
      });
    } catch (err) {
      const code = err instanceof AccountsRpcError ? err.code : 'internal';
      return reply
        .code(code === 'link_offline' ? 503 : 500)
        .send({ error: code, message: err instanceof Error ? err.message : String(err) });
    }
    reply.hijack();
    raw.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    // Headers out now so the CLI knows the subscription is live.
    raw.write('');
    req.raw.on('close', finish);
  });
  app.get('/accounts', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    return accountsCall(reply, { op: 'list' });
  });
  app.get('/internal/tool-prompts', async (_req, reply) => {
    if (!opts.toolPromptOverrides) {
      return reply.code(503).send({ error: 'tool prompts not wired on this host' });
    }
    return opts.toolPromptOverrides();
  });
  app.get('/internal/accounts', async (_req, reply) => accountsCall(reply, { op: 'list' }));
  app.put('/accounts/:backendId/order', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    const params = AccountsBackendParams.safeParse(req.params);
    const body = AccountsOrderBody.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: (!params.success ? params.error : body.error!).message,
      });
    }
    return accountsCall(reply, {
      op: 'order',
      backendId: params.data.backendId,
      accountIds: body.data.accountIds,
    });
  });
  app.put('/accounts/:backendId/strategy', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    const params = AccountsBackendParams.safeParse(req.params);
    const body = AccountsStrategyBody.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: (!params.success ? params.error : body.error!).message,
      });
    }
    return accountsCall(reply, {
      op: 'strategy',
      backendId: params.data.backendId,
      strategy: body.data.strategy,
    });
  });

  // GET /backends — each backend's version and this host's view of the shared accounts.
  app.get('/backends', async (req, reply) => {
    const host = hostGate(req, reply);
    if (!host) return;
    return { backends: host.backends.list(), accounts: host.backends.accounts() };
  });

  // GET /models — this host's catalogue across its backends. A backend that
  // failed to answer is reported in `errors` ALONGSIDE the models that did
  // resolve — never silently dropped.
  app.get('/models', async (req, reply) => {
    const host = hostGate(req, reply);
    if (!host) return;
    return await host.models();
  });

  // POST /components/install — install an optional component.
  app.post('/components/install', async (req, reply) => {
    const host = hostGate(req, reply);
    if (!host) return;
    const parsed = z
      .object({ componentId: z.string().min(1) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    }
    try {
      host.components.install(parsed.data.componentId);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: 'component_not_offered', message: (err as Error).message });
    }
    return { ok: true, components: host.describe().components };
  });

  // POST /components/remove — delete an installed component.
  app.post('/components/remove', async (req, reply) => {
    const host = hostGate(req, reply);
    if (!host) return;
    const parsed = z
      .object({ componentId: z.string().min(1) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    }
    try {
      host.components.remove(parsed.data.componentId);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: 'component_not_offered', message: (err as Error).message });
    }
    return { ok: true, components: host.describe().components };
  });

  // POST /update — apply an available host update. A host that knows of no
  // newer build says so rather than reporting a no-op as an applied update.
  app.post('/update', async (req, reply) => {
    const host = hostGate(req, reply);
    if (!host) return;
    const result = await host.update();
    // Accepted, but held until this host's running turns finish.
    if (result.deferred)
      return reply.code(202).send({ ok: true, deferred: true, message: result.message });
    if (!result.applied) {
      return reply.code(409).send({ error: 'no_update_available', message: result.message });
    }
    return { ok: true, message: result.message };
  });

  // POST /stop — shut the host down.
  app.post('/stop', async (req, reply) => {
    const auth = checkAuth(req);
    if (!auth.ok) return reply.code(401).send({ error: auth.reason });
    if (!opts.onShutdown) return reply.code(503).send({ error: 'shutdown not wired' });
    // Reply first, then trigger shutdown on the next tick so the client gets
    // a clean 200 before the process tears down.
    setImmediate(() => opts.onShutdown!());
    return { ok: true };
  });

  // --- Internal endpoints (cross-chat tools, no auth) -----------------------

  function require503(reply: import('fastify').FastifyReply): boolean {
    if (!opts.daemon) {
      reply.code(503).send({ error: 'host not initialised' });
      return true;
    }
    return false;
  }

  // --- Link/offline diagnostics (spec/12 ## Observability) ------------------
  // These back `patch doctor` and the offline/reconnect e2e checks against the
  // RUNNING host. They report/act on the real ServerLink; when the link isn't
  // wired (in-process control smoke tests) they 503.

  // GET /internal/diag/link — host→server link status + offline-buffer size.
  app.get('/internal/diag/link', async (_req, reply) => {
    if (!opts.serverLink) {
      return reply.code(503).send({ error: 'server link not wired' });
    }
    return opts.serverLink.diagnostics();
  });

  // POST /internal/diag/drop-link — sever the upstream socket while the host
  // stays alive (spec/12 "Host → server disconnect"). Outbound events buffer;
  // backoff reconnect fires. Returns { dropped: boolean }.
  app.post('/internal/diag/drop-link', async (_req, reply) => {
    if (!opts.serverLink) {
      return reply.code(503).send({ error: 'server link not wired' });
    }
    const dropped = opts.serverLink.dropLink();
    return { dropped };
  });

  // POST /internal/diag/flood-buffer — push N synthetic outbound events for a
  // single chat into the offline buffer (spec/12 "max 10k events per chat; drop
  // oldest with a warning"). Drives the bounded-buffer cap/drop/warn on the
  // RUNNING host, where an organic event flood is infeasible (the cross-chat
  // send-to path is rate-limited to 60/min). Sever the link first
  // (/internal/diag/drop-link) so events buffer rather than going to the wire,
  // then flood, then read /internal/diag/link to observe the cap. Returns
  // { bufferSize } — the real post-push buffer occupancy, which the cap clamps.
  const FloodBufferBody = z
    .object({
      chatId: z.string().min(1),
      count: z.number().int().positive().max(1_000_000),
    })
    .strict();
  app.post('/internal/diag/flood-buffer', async (req, reply) => {
    if (!opts.serverLink) {
      return reply.code(503).send({ error: 'server link not wired' });
    }
    const parsed = FloodBufferBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const bufferSize = opts.serverLink.floodBuffer(parsed.data.chatId, parsed.data.count);
    return { bufferSize };
  });

  // GET /internal/diag/resume/:id — the resume argument handed to the SDK on
  // the chat's most-recent query (spec/02 ## Host restart behaviour). Lets
  // the restart-resume guarantee (D3-6) be OBSERVED on the running app.
  app.get<{ Params: { id: string } }>('/internal/diag/resume/:id', async (req, reply) => {
    if (require503(reply)) return;
    const diag = opts.daemon!.lastQueryDiagnostics(req.params.id);
    if (!diag) {
      return reply
        .code(404)
        .send({ error: 'no_query_run', message: 'no query has run for this chat' });
    }
    return { resumeSessionId: diag.resumeSessionId ?? null, at: diag.at };
  });

  // patch_peek — spec/06: returns { chat_state, events, truncated }, built by
  // the server from its record and chat status (spec/03 § Cross-chat tools):
  //   chat_state — the chat's list entry and server status, with its host and
  //                whether that host is online.
  //   events     — the most-recent slice of the chat's record
  //                (default limit 50, configurable via ?limit up to 200).
  //   truncated  — true when older entries exist beyond the returned slice; the
  //                calling agent should call patch_history to paginate.
  // No LLM summary pass, and no host is asked: a chat on an offline host
  // reads like any other.
  app.get<{ Params: { id: string }; Querystring: { limit?: string; callerChatId?: string } }>(
    '/internal/peek/:id',
    async (req, reply) => {
      const start = Date.now();
      if (require503(reply)) return;
      let limit = 50;
      if (req.query.limit !== undefined) {
        const parsed = Math.floor(Number(req.query.limit));
        // Floored first: 0.5 is "positive" but would ask for zero events.
        if (!Number.isFinite(parsed) || parsed < 1) {
          return reply
            .code(400)
            .send({ error: 'invalid_input', message: `limit must be a positive number` });
        }
        limit = Math.min(200, parsed);
      }
      if (!opts.peekFromServer) {
        return reply
          .code(503)
          .send({ error: 'unavailable', message: 'patch_peek: no Patch server to read from' });
      }
      try {
        const result = await opts.peekFromServer({
          sourceChatId: req.query.callerChatId ?? 'cli',
          targetChatId: req.params.id,
          limit,
        });
        toolLog({
          tool: 'patch_peek',
          ...(req.query.callerChatId !== undefined ? { callerChatId: req.query.callerChatId } : {}),
          targetChatId: req.params.id,
          durationMs: Date.now() - start,
          ok: true,
        });
        return result;
      } catch (err) {
        const code = err instanceof RemoteRelayError ? err.code : 'sdk_error';
        toolLog({
          tool: 'patch_peek',
          ...(req.query.callerChatId !== undefined ? { callerChatId: req.query.callerChatId } : {}),
          targetChatId: req.params.id,
          durationMs: Date.now() - start,
          ok: false,
          err: code,
        });
        return reply.code(code === 'chat_not_found' ? 404 : 502).send({
          error: code,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // patch_send_to.
  app.post('/internal/send-to', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = SendToBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, message, voicePrefix, callerChatId, goal } = parsed.data;
    // Archiving is the user saying "finished", and a message wakes the chat, so
    // the sender is stopped before anything is sent, goal set or dedupe claimed
    // and must ask the user (spec/04 § Lifecycle). Local targets only: the
    // archive state of a chat on another host is not known here.
    if (opts.daemon!.chatState.get(chatId)?.status === 'archived' && !parsed.data.confirmArchived) {
      toolLog({
        tool: 'patch_send_to',
        callerChatId,
        targetChatId: chatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'target_archived',
      });
      return reply.code(409).send({
        error: 'target_archived',
        message: `patch_send_to: chat ${chatId} was archived, which the user does this on purpose, and a message would start it running again. Nothing was sent. Ask the user whether to wake it; if they say yes, resend with confirmArchived: true.`,
      });
    }
    // A hidden automation often delegates work and receives the result through
    // patch_send_to. Treating that host-to-host return as though a visible
    // agent had deliberately surfaced the recipient leaked every hidden job into
    // the main sidebar. Only a caller the user can already see reveals its target.
    // callerChatId is always present (required above); an unknown/stale id
    // still reveals, same safe default as before.
    const callerState = opts.daemon!.chatState.get(callerChatId);
    const revealTarget = callerState?.hidden !== true;
    const localId = parsed.data.localId ?? randomUUID();
    const dedupeKey = JSON.stringify([
      callerChatId,
      chatId,
      voicePrefix ?? '',
      message,
      goal ?? '',
    ]);
    // Prune on every call, including ones that carry a localId, so the map
    // cannot grow unbounded when callers always pass one.
    const now = Date.now();
    for (const [k, at] of recentSendTos) if (now - at >= SEND_TO_DEDUPE_MS) recentSendTos.delete(k);
    if (parsed.data.localId === undefined) {
      if (recentSendTos.has(dedupeKey)) {
        toolLog({
          tool: 'patch_send_to',
          callerChatId,
          targetChatId: chatId,
          durationMs: Date.now() - start,
          ok: true,
        });
        return { ok: true, queued: true, duplicate: true };
      }
    }
    if (!limiter.check(`send_to:${callerChatId}`)) {
      toolLog({
        tool: 'patch_send_to',
        callerChatId,
        targetChatId: chatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'rate_limited',
      });
      return sendRateLimited(reply, `send_to:${callerChatId}`);
    }
    // Claimed BEFORE the awaits: the retry this guard exists for arrives while
    // the first call is still in flight. Released on any failure so a genuine
    // retry after an error still goes through.
    const dedupeClaimed = parsed.data.localId === undefined;
    if (dedupeClaimed) recentSendTos.set(dedupeKey, Date.now());
    const releaseClaim = () => {
      if (dedupeClaimed) recentSendTos.delete(dedupeKey);
    };
    try {
      // A goal is set on a chat here only; elsewhere it is refused below.
      if (goal !== undefined) {
        if (isForeignSpecialThread(chatId)) throw new ChatNotFoundError(chatId);
        await opts.daemon!.setGoal(chatId, goal);
      }
      // Read before the send: delivering un-archives the target, and the sender
      // is told it was archived (spec/04 § Lifecycle).
      const targetWasArchived = opts.daemon!.chatState.get(chatId)?.status === 'archived';
      // Accepted, not finished: the sender is inside its own turn and must not
      // wait out the target's.
      await deliverToChat!({
        callerChatId,
        chatId,
        message,
        localId,
        revealTarget,
        ...(voicePrefix !== undefined ? { voicePrefix } : {}),
      });
      toolLog({
        tool: 'patch_send_to',
        callerChatId,
        targetChatId: chatId,
        durationMs: Date.now() - start,
        ok: true,
      });
      return targetWasArchived
        ? {
            ok: true,
            queued: true,
            targetWasArchived: true,
            note: 'The target chat was archived. The message un-archived it and it is running again.',
          }
        : { ok: true, queued: true };
    } catch (err) {
      releaseClaim();
      const code =
        err instanceof RemoteRelayError
          ? err.code
          : err instanceof ChatNotFoundError
            ? goal !== undefined
              ? 'goal_remote_unsupported'
              : 'chat_not_found'
            : 'sdk_error';
      toolLog({
        tool: 'patch_send_to',
        callerChatId,
        targetChatId: chatId,
        durationMs: Date.now() - start,
        ok: false,
        err: code,
      });
      if (code === 'goal_remote_unsupported') {
        return reply.code(400).send({
          error: code,
          message: `patch_send_to: chat ${chatId} is not on this host, and a goal can only be set on a chat here. Nothing was sent.`,
        });
      }
      const status = code === 'chat_not_found' ? 404 : err instanceof RemoteRelayError ? 502 : 500;
      return reply.code(status).send({
        error: code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // patch_send_back (spec/04 § Send back).
  app.post('/internal/send-back', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = SendBackBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, branchId } = parsed.data;
    try {
      const result = await opts.daemon!.sendBackToParent(chatId, branchId);
      toolLog({
        tool: 'patch_send_back',
        callerChatId: chatId,
        targetChatId: chatId,
        durationMs: Date.now() - start,
        ok: result.ok,
        ...(result.ok ? {} : { err: result.error }),
      });
      if (!result.ok) return reply.code(409).send({ error: 'refused', message: result.error });
      return { ok: true };
    } catch (err) {
      const code = err instanceof ChatNotFoundError ? 'chat_not_found' : 'sdk_error';
      toolLog({
        tool: 'patch_send_back',
        callerChatId: chatId,
        targetChatId: chatId,
        durationMs: Date.now() - start,
        ok: false,
        err: code,
      });
      return reply.code(code === 'chat_not_found' ? 404 : 500).send({
        error: code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // spec/14 § Document editor, step 2 of 3 — the three agent-side doc tools
  // (mcp.ts). Each host method already returns `{ok:true,value}|{ok:false,
  // code,message}` rather than throwing, so there is no try/catch here — just
  // a status-code mapping, same shape for all three.
  function docErrorStatus(code: string): number {
    if (code === 'chat_not_found' || code === 'not_found') return 404;
    if (code === 'path_escape' || code === 'conflict') return 409;
    if (code === 'invalid') return 400;
    if (code === 'browser_missing') return 503;
    return 500;
  }
  app.post('/internal/doc/suggest', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = DocSuggestBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, path, find, replace } = parsed.data;
    const result = opts.daemon!.suggestDoc(chatId, path, find, replace);
    toolLog({
      tool: 'patch_doc_suggest',
      callerChatId: chatId,
      targetChatId: chatId,
      durationMs: Date.now() - start,
      ok: result.ok,
      ...(result.ok ? {} : { err: result.code }),
    });
    if (!result.ok) {
      return reply
        .code(docErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }
    return result.value;
  });
  app.post('/internal/doc/comment', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = DocCommentBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, path, anchor, text } = parsed.data;
    const result = opts.daemon!.agentDocComment(chatId, path, anchor, text);
    toolLog({
      tool: 'patch_doc_comment',
      callerChatId: chatId,
      targetChatId: chatId,
      durationMs: Date.now() - start,
      ok: result.ok,
      ...(result.ok ? {} : { err: result.code }),
    });
    if (!result.ok) {
      return reply
        .code(docErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }
    return result.value;
  });
  app.post('/internal/doc/reply', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = DocReplyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, path, threadId, text } = parsed.data;
    const result = opts.daemon!.agentDocReply(chatId, path, threadId, text);
    toolLog({
      tool: 'patch_doc_reply',
      callerChatId: chatId,
      targetChatId: chatId,
      durationMs: Date.now() - start,
      ok: result.ok,
      ...(result.ok ? {} : { err: result.code }),
    });
    if (!result.ok) {
      return reply
        .code(docErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }
    return result.value;
  });

  // Word import/export (spec/14 § Document editor, step 3 of 3) — agent tool path.
  app.post('/internal/doc/convert', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = DocConvertBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, path } = parsed.data;
    const result = await opts.daemon!.convertDocx(chatId, path);
    toolLog({
      tool: 'patch_doc_convert',
      callerChatId: chatId,
      targetChatId: chatId,
      durationMs: Date.now() - start,
      ok: result.ok,
      ...(result.ok ? {} : { err: result.code }),
    });
    if (!result.ok) {
      return reply
        .code(docErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }
    return result.value;
  });
  app.post('/internal/doc/export', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = DocExportBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, path, format } = parsed.data;
    const result = await opts.daemon!.exportDoc(chatId, path, format);
    toolLog({
      tool: 'patch_doc_export',
      callerChatId: chatId,
      targetChatId: chatId,
      durationMs: Date.now() - start,
      ok: result.ok,
      ...(result.ok ? {} : { err: result.code }),
    });
    if (!result.ok) {
      return reply
        .code(docErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }
    // The agent tool returns path + warnings only, not the bytes (mcp.ts) —
    // no point shipping base64 binary content through the socket just to
    // discard it immediately after.
    return { path: result.value.path, warnings: result.value.warnings };
  });

  // patch_wake_me — schedule a durable self-wake (spec/02 § Self-wake).
  app.post('/internal/wake', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = WakeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, message, in: inDelay, at, every, notAfter } = parsed.data;
    // patch_loop reuses this same route (`every` set, `in`/`at` omitted), so
    // the tool-log name reflects which tool actually called it.
    const tool = every !== undefined ? 'patch_loop' : 'patch_wake_me';
    if (!limiter.check(`wake:${chatId}`)) {
      toolLog({
        tool,
        callerChatId: chatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'rate_limited',
      });
      return sendRateLimited(reply, `wake:${chatId}`);
    }
    try {
      const res = opts.daemon!.scheduleWake(chatId, {
        message,
        ...(inDelay !== undefined ? { in: inDelay } : {}),
        ...(at !== undefined ? { at } : {}),
        ...(every !== undefined ? { every } : {}),
        ...(notAfter !== undefined ? { notAfter } : {}),
      });
      toolLog({
        tool,
        callerChatId: chatId,
        durationMs: Date.now() - start,
        ok: true,
      });
      const fireAtIso = new Date(res.fireAt).toISOString();
      if (res.unchanged) {
        return {
          ok: true,
          fireAt: res.fireAt,
          fireAtIso,
          unchanged: true,
          note: `An identical loop was already pending; kept its schedule (next fire ${fireAtIso}). Re-arming is unnecessary.`,
        };
      }
      return {
        ok: true,
        fireAt: res.fireAt,
        fireAtIso,
        ...(res.replaced
          ? {
              replaced: wakeSummary(res.replaced),
              note: `Replaced a pending ${res.replaced.every !== undefined ? 'loop' : 'wake'} that was due ${new Date(res.replaced.fireAt).toISOString()}; next fire is now ${fireAtIso}.`,
            }
          : {}),
      };
    } catch (err) {
      const code = err instanceof ChatNotFoundError ? 'chat_not_found' : 'invalid_input';
      toolLog({
        tool,
        callerChatId: chatId,
        durationMs: Date.now() - start,
        ok: false,
        err: code,
      });
      return reply
        .code(code === 'chat_not_found' ? 404 : 400)
        .send({ error: code, message: err instanceof Error ? err.message : String(err) });
    }
  });

  // patch_wake_status — read the chat's pending self-wake without re-arming.
  app.post('/internal/wake/status', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = WakeCancelBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const rec = opts.daemon!.peekWake(parsed.data.chatId);
    return { ok: true, pending: rec ? wakeSummary(rec) : null };
  });

  // patch_cancel_wake — cancel the chat's pending self-wake (stop the loop).
  app.post('/internal/wake/cancel', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = WakeCancelBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const cancelled = opts.daemon!.cancelWake(parsed.data.chatId);
    return { ok: true, cancelled };
  });

  // patch_goal_set / patch_goal_clear — set (or clear, with `goal: null`)
  // this chat's goal (spec/04 § Goals, spec/06 § Tools).
  app.post('/internal/goal', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = GoalSetBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, goal, then, remindEvery, checkInEvery } = parsed.data;
    const tool = 'patch_goal_set';
    try {
      await opts.daemon!.setGoal(chatId, goal, {
        ...(then !== undefined ? { then } : {}),
        ...(remindEvery !== undefined ? { remindEvery } : {}),
        ...(checkInEvery !== undefined ? { checkInEvery } : {}),
      });
      toolLog({ tool, callerChatId: chatId, durationMs: Date.now() - start, ok: true });
      return { ok: true, goal };
    } catch (err) {
      const code = err instanceof ChatNotFoundError ? 'chat_not_found' : 'invalid_input';
      toolLog({ tool, callerChatId: chatId, durationMs: Date.now() - start, ok: false, err: code });
      return reply
        .code(code === 'chat_not_found' ? 404 : 400)
        .send({ error: code, message: err instanceof Error ? err.message : String(err) });
    }
  });

  // patch_goal_clear — the agent asks to end its goal as met/impossible; the
  // goal judge must agree (spec/04 § Goals). A bare clear is not available here.
  app.post('/internal/goal/finish', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = GoalFinishBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, verdict, reason } = parsed.data;
    try {
      const out = await opts.daemon!.claimGoalOutcome(chatId, verdict, reason);
      toolLog({
        tool: 'patch_goal_clear',
        callerChatId: chatId,
        durationMs: Date.now() - start,
        ok: true,
      });
      return { ok: out.accepted, ...out };
    } catch (err) {
      const code = err instanceof ChatNotFoundError ? 'chat_not_found' : 'invalid_input';
      toolLog({
        tool: 'patch_goal_clear',
        callerChatId: chatId,
        durationMs: Date.now() - start,
        ok: false,
        err: code,
      });
      return reply
        .code(code === 'chat_not_found' ? 404 : 400)
        .send({ error: code, message: err instanceof Error ? err.message : String(err) });
    }
  });

  // patch_goal_get — read this chat's goal + live progress, or its most
  // recently finished one (spec/04 § Goals, spec/06 § Tools).
  app.get<{ Querystring: { chatId?: string } }>('/internal/goal', async (req, reply) => {
    if (require503(reply)) return;
    const chatId = req.query.chatId;
    if (chatId === undefined || chatId.length === 0) {
      return reply.code(400).send({ error: 'invalid_input', message: 'chatId is required' });
    }
    const state = opts.daemon!.chatState.get(chatId);
    if (!state) {
      return reply.code(404).send({ error: 'chat_not_found', message: `no chat ${chatId}` });
    }
    return {
      ok: true,
      goal: state.goal,
      goalQueue: state.goalQueue,
      goalReminderEvery: state.goalReminderEvery,
      goalCheckInEvery: state.goalCheckInEvery,
      goalProgress: state.goalProgress,
      lastGoal: state.lastGoal,
    };
  });

  // patch_watch — start a durable, host-owned background task.
  app.post('/internal/watch', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = WatchStartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const {
      chatId,
      command,
      description,
      timeoutSec,
      checkInSec,
      wakeOnMatch,
      rerunOnReboot,
      cwd,
    } = parsed.data;
    if (!limiter.check(`watch:${chatId}`)) {
      toolLog({
        tool: 'patch_watch',
        callerChatId: chatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'rate_limited',
      });
      return sendRateLimited(reply, `watch:${chatId}`);
    }
    try {
      const rec = opts.daemon!.startWatch(chatId, {
        command,
        description,
        timeoutSec,
        ...(checkInSec !== undefined ? { checkInSec } : {}),
        ...(wakeOnMatch !== undefined ? { wakeOnMatch } : {}),
        ...(rerunOnReboot !== undefined ? { rerunOnReboot } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
      toolLog({
        tool: 'patch_watch',
        callerChatId: chatId,
        durationMs: Date.now() - start,
        ok: true,
      });
      return { ok: true, taskId: rec.taskId };
    } catch (err) {
      const code = err instanceof ChatNotFoundError ? 'chat_not_found' : 'invalid_input';
      toolLog({
        tool: 'patch_watch',
        callerChatId: chatId,
        durationMs: Date.now() - start,
        ok: false,
        err: code,
      });
      return reply
        .code(code === 'chat_not_found' ? 404 : 400)
        .send({ error: code, message: err instanceof Error ? err.message : String(err) });
    }
  });

  // patch_watch_list — every watch this chat has running or recently ended.
  app.get<{ Querystring: { chatId?: string } }>('/internal/watch', async (req, reply) => {
    if (require503(reply)) return;
    const chatId = req.query.chatId;
    if (!chatId) {
      return reply.code(400).send({ error: 'invalid_input', message: 'chatId is required' });
    }
    const tasks = opts.daemon!.listWatch(chatId);
    return { tasks };
  });

  // patch_watch_output — a task's combined stdout+stderr.
  app.get<{ Params: { taskId: string }; Querystring: { chatId?: string; tail?: string } }>(
    '/internal/watch/:taskId/output',
    async (req, reply) => {
      if (require503(reply)) return;
      const chatId = req.query.chatId;
      if (!chatId) {
        return reply.code(400).send({ error: 'invalid_input', message: 'chatId is required' });
      }
      const tail = req.query.tail !== undefined ? Number(req.query.tail) : undefined;
      if (tail !== undefined && (!Number.isInteger(tail) || tail < 0)) {
        return reply
          .code(400)
          .send({ error: 'invalid_input', message: 'tail must be a non-negative integer' });
      }
      try {
        const output = opts.daemon!.watchOutput(chatId, req.params.taskId, tail);
        return { output };
      } catch (err) {
        return reply.code(404).send({
          error: 'task_not_found',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // patch_watch_stop — kill a running task's process group outright.
  app.post<{ Params: { taskId: string } }>('/internal/watch/:taskId/stop', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = WatchStopBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const stopped = opts.daemon!.stopWatch(parsed.data.chatId, req.params.taskId);
    return { ok: true, stopped };
  });

  // --- Browser (spec/02 § Browser, spec/06 § Browser tools) -----------------

  // patch_browser_open — navigate a new tab, in the shared 'logged-in'
  // profile by default or a throwaway 'logged-out' one.
  app.post('/internal/browser/open', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = BrowserOpenBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, url, profile } = parsed.data;
    try {
      const result = await opts.daemon!.browserOpen(
        chatId,
        url,
        profile as BrowserProfile | undefined,
      );
      return { ok: true, ...result };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  // patch_browser_read — accessible-ish snapshot of the tab's current page.
  app.post('/internal/browser/read', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = BrowserReadBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    try {
      const { tabId, ...readOpts } = parsed.data;
      const result = await opts.daemon!.browserRead(tabId, readOpts);
      return { ok: true, ...result };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  // patch_browser_click
  app.post('/internal/browser/click', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = BrowserClickBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    try {
      await opts.daemon!.browserClick(parsed.data.tabId, parsed.data.ref);
      return { ok: true };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  // patch_browser_handoff — blocks until the user finishes with the tab.
  app.post('/internal/browser/handoff', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = BrowserHandoffBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { timeoutSeconds, share, ...rest } = parsed.data;
    try {
      if (share === true) {
        if (rest.callbackPort !== undefined || timeoutSeconds !== undefined) {
          return reply.code(400).send({
            error: 'invalid_input',
            message: 'share cannot be combined with callbackPort or timeoutSeconds',
          });
        }
        const shared = await opts.daemon!.browserShare(rest);
        return { ok: true, ...shared };
      }
      const result = await opts.daemon!.browserHandoff({
        ...rest,
        ...(timeoutSeconds !== undefined ? { timeoutMs: timeoutSeconds * 1000 } : {}),
      });
      return { ok: true, ...result };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  // patch_browser_mouse — coordinate pointer actions; returns a fresh screenshot.
  app.post('/internal/browser/mouse', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = BrowserMouseBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    try {
      const { chatId, tabId, ...pointer } = parsed.data;
      const result = await opts.daemon!.browserMouse(chatId, tabId, pointer);
      return { ok: true, ...result };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  // patch_browser_key — key presses/chords; returns a fresh screenshot.
  app.post('/internal/browser/key', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = BrowserKeyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    try {
      const result = await opts.daemon!.browserKey(
        parsed.data.chatId,
        parsed.data.tabId,
        parsed.data.keys,
      );
      return { ok: true, ...result };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  // patch_browser_type — real keystrokes, human-paced.
  app.post('/internal/browser/type', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = BrowserTypeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { tabId, ref, text, submit } = parsed.data;
    try {
      await opts.daemon!.browserType(tabId, ref, text, submit);
      return { ok: true };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  // patch_browser_fill_form — several fields in one call.
  app.post('/internal/browser/fill_form', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = BrowserFillFormBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    try {
      await opts.daemon!.browserFillForm(parsed.data.tabId, parsed.data.fields);
      return { ok: true };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  // patch_browser_select — a <select>'s option, by value.
  app.post('/internal/browser/select', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = BrowserSelectBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    try {
      await opts.daemon!.browserSelect(parsed.data.tabId, parsed.data.ref, parsed.data.value);
      return { ok: true };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  // patch_browser_upload — attach local file(s) to a file input.
  app.post('/internal/browser/upload', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = BrowserUploadBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    try {
      await opts.daemon!.browserUpload(parsed.data.tabId, parsed.data.filePaths, parsed.data.ref);
      return { ok: true };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  // patch_browser_screenshot
  app.post('/internal/browser/screenshot', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = BrowserScreenshotBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    try {
      const { tabId, ...shotOpts } = parsed.data;
      const result = await opts.daemon!.browserScreenshot(tabId, shotOpts);
      return { ok: true, ...result };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  // patch_browser_tabs — every open tab, across every chat on this host.
  app.get('/internal/browser/tabs', async (_req, reply) => {
    if (require503(reply)) return;
    const tabs = await opts.daemon!.browserTabs();
    return { ok: true, tabs };
  });

  // patch_browser_close
  app.post('/internal/browser/close', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = BrowserTabIdBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    try {
      await opts.daemon!.browserClose(parsed.data.tabId);
      return { ok: true };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  // The rest of the agent browser (spec/06 § Browser tools): one JSON in, one JSON out.
  const browserRoute = <S extends z.ZodTypeAny>(
    name: string,
    schema: S,
    run: (body: z.infer<S>) => Promise<unknown> | unknown,
  ): void => {
    app.post(`/internal/browser/${name}`, async (req, reply) => {
      if (require503(reply)) return;
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
      }
      try {
        const result = await run(parsed.data);
        return { ok: true, ...(result && typeof result === 'object' ? result : {}) };
      } catch (err) {
        return sendBrowserError(reply, err);
      }
    });
  };
  const daemon = (): NonNullable<typeof opts.daemon> => opts.daemon!;

  browserRoute('navigate', BrowserNavigateBody, (b) =>
    daemon().browserNavigate(b.tabId, b.action, b.url),
  );
  browserRoute('switch_tab', BrowserTabIdBody, (b) => daemon().browserSwitchTab(b.tabId));
  browserRoute('wait', BrowserWaitBody, ({ tabId, ...c }) => daemon().browserWait(tabId, c));
  browserRoute('interact', BrowserInteractBody, ({ tabId, ...req }) =>
    daemon().browserInteract(tabId, req),
  );
  browserRoute('dialog', BrowserDialogBody, ({ tabId, ...req }) =>
    daemon().browserDialog(tabId, req),
  );
  browserRoute('downloads', BrowserDownloadsBody, async (b) => ({
    downloads: await daemon().browserDownloads(
      b.tabId,
      b.waitSeconds !== undefined ? b.waitSeconds * 1000 : undefined,
    ),
  }));
  browserRoute('state', BrowserStateBody, async ({ tabId, ...req }) => {
    const result = await daemon().browserState(tabId, req);
    // `get` returns the state itself; everything else a small summary.
    return req.action === 'get' ? { state: result } : result;
  });
  browserRoute('eval', BrowserEvalBody, (b) =>
    daemon().browserEval(b.tabId, b.expression, b.frameUrl),
  );
  browserRoute('console', BrowserConsoleBody, async ({ tabId, ...o }) => ({
    messages: await daemon().browserConsole(tabId, o),
  }));
  browserRoute('network', BrowserNetworkBody, ({ tabId, ...o }) =>
    daemon().browserNetwork(tabId, o),
  );
  browserRoute('viewport', BrowserViewportBody, ({ tabId, ...req }) =>
    daemon().browserViewport(tabId, req),
  );

  // A caller blocked on a subagent (`wait: true`) whose connection dies before
  // the result arrives (the host or its tool bridge restarted under it) will
  // never read the answer. Stop waiting for it, so the result is delivered into
  // the parent as a turn instead of being resolved into a dead socket.
  const abandonDelegateWaitOnClose = (reply: FastifyReply, id: string): void => {
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) opts.daemon!.abandonDelegateWait(id);
    });
  };

  // patch_delegate — create a durable subagent chat under the caller.
  app.post('/internal/delegate', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = DelegateStartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, prompt, title, model, folder, account, disallowedTools, wait } = parsed.data;
    if (opts.daemon!.isSubagent(chatId)) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'An agent cannot start agents or chats; only a chat the user is in can.',
      });
    }
    if (!limiter.check(`delegate:${chatId}`)) {
      toolLog({
        tool: 'patch_delegate',
        callerChatId: chatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'rate_limited',
      });
      return sendRateLimited(reply, `delegate:${chatId}`);
    }
    let preferredAccountId: string | undefined;
    if (account !== undefined) {
      try {
        preferredAccountId = resolveSpawnAccount(account, model);
      } catch (err) {
        toolLog({
          tool: 'patch_delegate',
          callerChatId: chatId,
          durationMs: Date.now() - start,
          ok: false,
          err: 'account_not_found',
        });
        return reply.code(400).send({
          error: 'account_not_found',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      const { id, label, result } = await opts.daemon!.createDelegate({
        parentChatId: chatId,
        prompt,
        ...(preferredAccountId !== undefined ? { preferredAccountId } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(folder !== undefined ? { folder } : {}),
        ...(disallowedTools !== undefined ? { disallowedTools } : {}),
        ...(wait ? { wait } : {}),
      });
      toolLog({
        tool: 'patch_delegate',
        callerChatId: chatId,
        targetChatId: id,
        durationMs: Date.now() - start,
        ok: true,
      });
      if (result) {
        abandonDelegateWaitOnClose(reply, id);
        return { id, label, ...(await result) };
      }
      return { id, label };
    } catch (err) {
      const code = err instanceof ChatNotFoundError ? 'chat_not_found' : 'invalid_input';
      toolLog({
        tool: 'patch_delegate',
        callerChatId: chatId,
        durationMs: Date.now() - start,
        ok: false,
        err: code,
      });
      return reply
        .code(code === 'chat_not_found' ? 404 : 400)
        .send({ error: code, message: err instanceof Error ? err.message : String(err) });
    }
  });

  // patch_delegate_send — follow-up to one of the caller's own subagents.
  app.post('/internal/delegate/send', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = DelegateSendBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { chatId, id, message, wait } = parsed.data;
    try {
      const { result } = await opts.daemon!.sendToDelegate({
        parentChatId: chatId,
        id,
        message,
        ...(wait ? { wait } : {}),
      });
      if (result) {
        abandonDelegateWaitOnClose(reply, id);
        return { id, ...(await result) };
      }
      return { id };
    } catch (err) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // patch_delegate_list — every subagent the caller has created.
  app.get<{ Querystring: { chatId?: string } }>('/internal/delegate', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = DelegateListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const delegates = opts.daemon!.listDelegates(parsed.data.chatId);
    return { delegates };
  });

  // patch_delegate_stop — stop one of the caller's own subagents.
  app.post('/internal/delegate/stop', async (req, reply) => {
    if (require503(reply)) return;
    const parsed = DelegateStopBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const stopped = await opts.daemon!.stopDelegate(parsed.data.chatId, parsed.data.id);
    return { ok: true, stopped };
  });

  // patch_spawn.
  app.post('/internal/spawn', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = SpawnBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const {
      folder,
      host,
      name,
      prompt,
      callerChatId,
      model,
      permissionMode,
      account,
      goal,
      hidden,
    } = parsed.data;
    if (callerChatId !== undefined && opts.daemon!.isSubagent(callerChatId)) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'An agent cannot start agents or chats; only a chat the user is in can.',
      });
    }
    const limiterKey = callerChatId ?? 'anonymous';
    if (!limiter.check(`spawn:${limiterKey}`)) {
      toolLog({
        tool: 'patch_spawn',
        callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'rate_limited',
      });
      return sendRateLimited(reply, `spawn:${limiterKey}`);
    }
    const selfHostId = opts.daemon!.hostId;
    let preferredAccountId: string | undefined;
    if (account !== undefined) {
      try {
        preferredAccountId = resolveSpawnAccount(account, model);
      } catch (err) {
        toolLog({
          tool: 'patch_spawn',
          callerChatId,
          durationMs: Date.now() - start,
          ok: false,
          err: 'account_not_found',
        });
        return reply.code(400).send({
          error: 'account_not_found',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // spec/03 § Cross-chat tools — a call whose target is on the calling chat's
    // own host is short-circuited in-process; one naming another host
    // goes over the wire, relayed by the server to that host.
    if (host !== undefined && host !== selfHostId) {
      if (hidden === true) {
        return reply.code(400).send({
          error: 'hidden_remote_unsupported',
          message: `patch_spawn: hidden can only be set on a chat created on this machine, not on ${host}. No chat was created.`,
        });
      }
      if (goal !== undefined) {
        return reply.code(400).send({
          error: 'goal_remote_unsupported',
          message: `patch_spawn: a goal can only be set on a chat created on this host, not on ${host}. No chat was created.`,
        });
      }
      if (!callerChatId) {
        return reply
          .code(400)
          .send({ error: 'invalid_input', message: 'a cross-host spawn needs a calling chat' });
      }
      if (!opts.spawnOnRemoteHost || !opts.isHostOnline) {
        return reply.code(503).send({
          error: 'link_offline',
          message: `patch_spawn: this host has no server link, so it cannot spawn on ${host}`,
        });
      }
      if (!opts.isHostOnline(host)) {
        // Resolved INSIDE the turn rather than buffered: a tool result is part
        // of a turn in progress, and the agent decides what to do about the
        // host being down.
        toolLog({
          tool: 'patch_spawn',
          callerChatId,
          durationMs: Date.now() - start,
          ok: false,
          err: 'host_offline',
        });
        return reply.code(409).send({
          error: 'host_offline',
          message: `patch_spawn: host ${host} is not online`,
        });
      }
      // The named host answers with its OWN outcome (spec/03 § Cross-chat
      // tools). NO FALLBACK: this used to return `created:'remote'` the instant
      // the frame left, so a host that refused the spawn — no model
      // catalogue, unknown folder — reported success to an agent that then
      // orchestrated a chat which did not exist.
      try {
        const remote = await opts.spawnOnRemoteHost({
          host,
          sourceChatId: callerChatId,
          folder,
          ...(model !== undefined ? { model } : {}),
          ...(prompt !== undefined ? { prompt } : {}),
          ...(preferredAccountId !== undefined ? { preferredAccountId } : {}),
        });
        toolLog({
          tool: 'patch_spawn',
          callerChatId,
          ...(remote.chatId !== undefined ? { targetChatId: remote.chatId } : {}),
          durationMs: Date.now() - start,
          ok: true,
        });
        return {
          host,
          folder,
          created: 'remote' as const,
          ...(remote.chatId !== undefined ? { chatId: remote.chatId } : {}),
        };
      } catch (err) {
        const code = err instanceof RemoteSpawnError ? err.code : 'sdk_error';
        toolLog({
          tool: 'patch_spawn',
          callerChatId,
          durationMs: Date.now() - start,
          ok: false,
          err: code,
        });
        const status =
          code === 'folder_not_found' ? 404 : code === 'no_model_catalogue' ? 409 : 502;
        return reply.code(status).send({
          error: code,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      const spawnReq: SpawnChatOptions = {
        folder,
        ...(name !== undefined ? { name } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(hidden === true ? { hidden: true } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
        ...(preferredAccountId !== undefined ? { preferredAccountId } : {}),
        ...(callerChatId !== undefined ? { spawnedByChatId: callerChatId } : {}),
      };
      const chatId = await opts.daemon!.spawnChat(spawnReq);
      if (goal !== undefined) {
        try {
          await opts.daemon!.setGoal(chatId, goal);
        } catch (err) {
          toolLog({
            tool: 'patch_spawn',
            callerChatId,
            targetChatId: chatId,
            durationMs: Date.now() - start,
            ok: false,
            err: 'goal_failed',
          });
          return reply.code(500).send({
            error: 'goal_failed',
            message: `patch_spawn created chat ${chatId} but setting its goal failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      }
      if (opts.emitWire && callerChatId) {
        opts.emitWire({
          type: 'patch.spawn',
          sourceChatId: callerChatId,
          // A local `patch_spawn` creates the chat on THIS host. The frame is
          // the audit record of that, so it names the host explicitly
          // rather than leaving a reader to assume the caller's.
          hostId: opts.daemon!.hostId,
          folder,
          ...(model !== undefined ? { model } : {}),
          prompt: prompt ?? '',
        });
      }
      toolLog({
        tool: 'patch_spawn',
        callerChatId,
        targetChatId: chatId,
        durationMs: Date.now() - start,
        ok: true,
      });
      // Names the host, so the agent can address the new chat afterwards
      // without assuming it landed on its own.
      return { chatId, host: selfHostId };
    } catch (err) {
      // A host with no model catalogue is its own answer to the agent
      // (spec/04 § Spawn): it names a model or connects the credential there.
      // Folding it into `sdk_error` would tell the agent to retry the same
      // model-less spawn forever.
      const code =
        err instanceof FolderNotFoundError
          ? 'folder_not_found'
          : err instanceof NoModelCatalogueError
            ? 'no_model_catalogue'
            : 'sdk_error';
      toolLog({
        tool: 'patch_spawn',
        callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: code,
      });
      const status = code === 'folder_not_found' ? 404 : code === 'no_model_catalogue' ? 409 : 500;
      return reply.code(status).send({
        error: code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // patch_history — a page of the chat's record, read from the server
  // (spec/03 § Cross-chat tools) whichever host owns the chat.
  app.get<{ Params: { id: string } }>('/internal/history/:id', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const params = StopParams.safeParse(req.params);
    // Unreachable: fastify's router never matches `:id` against an empty
    // segment, so `id` is always a non-empty string. Kept for defense-in-depth.
    /* v8 ignore next 3 */
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_input', message: params.error.message });
    }
    const q = HistoryQuery.safeParse(req.query);
    if (!q.success) {
      return reply.code(400).send({ error: 'invalid_input', message: q.error.message });
    }
    if (!opts.historyFromServer) {
      return reply
        .code(503)
        .send({ error: 'unavailable', message: 'patch_history: no Patch server to read from' });
    }
    const caller = q.data.callerChatId !== undefined ? { callerChatId: q.data.callerChatId } : {};
    try {
      const result = await opts.historyFromServer({
        sourceChatId: q.data.callerChatId ?? 'cli',
        targetChatId: params.data.id,
        ...(q.data.fromSeq !== undefined ? { fromSeq: q.data.fromSeq } : {}),
        ...(q.data.limit !== undefined ? { limit: Math.min(200, q.data.limit) } : {}),
      });
      toolLog({
        tool: 'patch_history',
        ...caller,
        targetChatId: params.data.id,
        durationMs: Date.now() - start,
        ok: true,
      });
      return result;
    } catch (err) {
      const code = err instanceof RemoteRelayError ? err.code : 'sdk_error';
      toolLog({
        tool: 'patch_history',
        ...caller,
        targetChatId: params.data.id,
        durationMs: Date.now() - start,
        ok: false,
        err: code,
      });
      return reply.code(code === 'chat_not_found' ? 404 : 502).send({
        error: code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // patch_list_chats.
  app.get('/internal/chats', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const q = ListChatsQuery.safeParse(req.query);
    if (!q.success) {
      return reply.code(400).send({ error: 'invalid_input', message: q.error.message });
    }
    // spec/03 § Cross-chat tools, spec/12 § Chat status — the list spans the
    // account and every entry carries the server's status, so only the server
    // can answer. NO FALLBACK to this host's own chats: a list that silently
    // omits another host's chats, or shows this host's view of a status, reads
    // as the truth when it is not. A caller outside a chat (the CLI in a
    // terminal) names none.
    if (!opts.listAccountChats) {
      return reply
        .code(503)
        .send({ error: 'unavailable', message: 'listing chats: no Patch server to ask' });
    }
    const caller = q.data.callerChatId;
    try {
      const chats = await opts.listAccountChats(
        caller ?? 'cli',
        q.data.archived !== undefined ? q.data.archived : undefined,
      );
      toolLog({
        tool: 'patch_list_chats',
        ...(caller !== undefined ? { callerChatId: caller } : {}),
        durationMs: Date.now() - start,
        ok: true,
      });
      return { chats };
    } catch (err) {
      toolLog({
        tool: 'patch_list_chats',
        ...(caller !== undefined ? { callerChatId: caller } : {}),
        durationMs: Date.now() - start,
        ok: false,
        err: 'sdk_error',
      });
      return reply.code(502).send({
        error: 'server_unreachable',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // patch_search_chats — answered by the server for the whole account; no
  // local fallback, a partial answer would read as "nothing else matches".
  app.get('/internal/search-chats', async (req, reply) => {
    const start = Date.now();
    const q = SearchChatsQuery.safeParse(req.query);
    if (!q.success) {
      return reply.code(400).send({ error: 'invalid_input', message: q.error.message });
    }
    if (!opts.searchAccountChats) {
      return reply.code(503).send({ error: 'chat search not configured' });
    }
    try {
      const answer = await opts.searchAccountChats(q.data.callerChatId, q.data.query, q.data.limit);
      // The agent finds a chat by its chatId and reads it with patch_peek /
      // patch_history, which route to the owning machine themselves. Naming the
      // machine here only invites the agent to reason about hosts.
      const result = {
        ...answer,
        results: (answer.results as Array<Record<string, unknown>>).map(
          ({ hostId: _hostId, ...rest }) => rest,
        ),
      };
      toolLog({
        tool: 'patch_search_chats',
        callerChatId: q.data.callerChatId,
        durationMs: Date.now() - start,
        ok: true,
      });
      return result;
    } catch (err) {
      toolLog({
        tool: 'patch_search_chats',
        callerChatId: q.data.callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'sdk_error',
      });
      return reply.code(502).send({
        error: 'search_unavailable',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // patch_activity — gathered server-side from every host's chat logs
  // (spec/06 § Cross-chat toolset): no local fallback exists, unlike
  // patch_list_chats's own-host partial view.
  app.get('/internal/activity', async (req, reply) => {
    const start = Date.now();
    const q = ActivityQuery.safeParse(req.query);
    if (!q.success) {
      return reply.code(400).send({ error: 'invalid_input', message: q.error.message });
    }
    if (!opts.getActivity) {
      return reply.code(503).send({ error: 'activity not configured' });
    }
    try {
      const result = await opts.getActivity(
        q.data.callerChatId,
        q.data.since,
        q.data.until,
        q.data.messagesCursor,
        q.data.limit,
        q.data.includeSessions,
        q.data.sessionsCursor,
      );
      toolLog({
        tool: 'patch_activity',
        callerChatId: q.data.callerChatId,
        durationMs: Date.now() - start,
        ok: true,
      });
      return result;
    } catch (err) {
      toolLog({
        tool: 'patch_activity',
        callerChatId: q.data.callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'sdk_error',
      });
      return reply.code(502).send({
        error: 'activity_unavailable',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // patch_stop.
  app.post<{ Params: { id: string } }>('/internal/stop/:id', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const params = StopParams.safeParse(req.params);
    // Unreachable: fastify's router never matches `:id` against an empty
    // segment, so `id` is always a non-empty string and this zod check can
    // never fail. Kept for defense-in-depth.
    /* v8 ignore next 3 */
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_input', message: params.error.message });
    }
    const callerChatId =
      typeof (req.body as { callerChatId?: unknown } | undefined)?.callerChatId === 'string'
        ? ((req.body as { callerChatId?: string }).callerChatId as string)
        : undefined;
    const limiterKey = callerChatId ?? 'anonymous';
    if (!limiter.check(`stop:${limiterKey}`)) {
      toolLog({
        tool: 'patch_stop',
        callerChatId,
        targetChatId: params.data.id,
        durationMs: Date.now() - start,
        ok: false,
        err: 'rate_limited',
      });
      return sendRateLimited(reply, `stop:${limiterKey}`);
    }
    try {
      // stopChat is already idempotent (no-op if already idle).
      // We still prefer to surface chat-not-found so callers learn typos.
      if (!opts.daemon!.chatState.has(params.data.id)) {
        // Not on this host: relay to whichever host owns it. NO
        // FALLBACK — the owner's refusal (or silence) comes back as the error.
        if (!opts.stopRemoteChat || !callerChatId) throw new ChatNotFoundError(params.data.id);
        await opts.stopRemoteChat({
          sourceChatId: callerChatId,
          targetChatId: params.data.id,
        });
        toolLog({
          tool: 'patch_stop',
          callerChatId,
          targetChatId: params.data.id,
          durationMs: Date.now() - start,
          ok: true,
        });
        return { ok: true };
      }
      if (opts.daemon!.refuseUnlessCapable(params.data.id, 'interrupt')) {
        return reply.code(409).send(INTERRUPT_UNSUPPORTED);
      }
      await opts.daemon!.stopChat(params.data.id);
      if (opts.emitWire && callerChatId) {
        opts.emitWire({
          type: 'patch.stop',
          sourceChatId: callerChatId,
          targetChatId: params.data.id,
        });
      }
      toolLog({
        tool: 'patch_stop',
        callerChatId,
        targetChatId: params.data.id,
        durationMs: Date.now() - start,
        ok: true,
      });
      return { ok: true };
    } catch (err) {
      const code =
        err instanceof ChatNotFoundError ||
        (err instanceof RemoteRelayError && err.code === 'chat_not_found')
          ? 'chat_not_found'
          : 'sdk_error';
      toolLog({
        tool: 'patch_stop',
        callerChatId,
        targetChatId: params.data.id,
        durationMs: Date.now() - start,
        ok: false,
        err: code,
      });
      return reply.code(code === 'chat_not_found' ? 404 : 500).send({
        error: code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // patch_artifact — publish an HTML file from the chat folder as a page the
  // user can open (spec/14 § Artifacts). Reads the file host-side (Claude
  // runs here), ships it to the server (which owns the public origin), then
  // stamps a slim `chat.artifact` into the chat's stream.
  app.post('/internal/artifact', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = ArtifactBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { path, title, callerChatId } = parsed.data;
    const state = opts.daemon!.chatState.get(callerChatId);
    if (!state) {
      return reply.code(404).send({
        error: 'chat_not_found',
        message: `chat not found: ${callerChatId}`,
      } satisfies ErrorEnvelope);
    }
    if (!opts.publishArtifact) {
      return reply.code(503).send({
        error: 'artifact_publisher_unavailable',
        message: 'artifact publishing is not wired on this host',
      } satisfies ErrorEnvelope);
    }

    let relPath: string;
    let html: string;
    try {
      const resolved = resolveArtifactPath(state.folder, path);
      relPath = resolved.relPath;
      const stat = statSync(resolved.absPath);
      if (!stat.isFile()) throw new ArtifactInputError(`not a file: ${path}`);
      if (stat.size > MAX_ARTIFACT_BYTES) {
        throw new ArtifactInputError(
          `artifact is ${stat.size} bytes — the limit is ${MAX_ARTIFACT_BYTES}`,
        );
      }
      html = readFileSync(resolved.absPath, 'utf8');
      if (html.trim().length === 0) throw new ArtifactInputError(`artifact file is empty: ${path}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const notFound =
        (err as NodeJS.ErrnoException).code === 'ENOENT' ||
        (err as NodeJS.ErrnoException).code === 'ENOTDIR';
      toolLog({
        tool: 'patch_artifact',
        callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: notFound ? 'not_found' : 'invalid_input',
      });
      return reply.code(notFound ? 404 : 400).send({
        error: notFound ? 'artifact_not_found' : 'invalid_input',
        message: notFound ? `file not found in the chat folder: ${path}` : message,
      } satisfies ErrorEnvelope);
    }

    const resolvedTitle = title ?? basename(relPath);
    const artifactId = artifactIdFor(callerChatId, relPath);
    let url: string;
    try {
      const published = await opts.publishArtifact({
        chatId: callerChatId,
        artifactId,
        title: resolvedTitle,
        path: relPath,
        html: toDocument(html, resolvedTitle),
      });
      url = published.url;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolLog({
        tool: 'patch_artifact',
        callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'publish_failed',
      });
      return reply
        .code(502)
        .send({ error: 'artifact_publish_failed', message } satisfies ErrorEnvelope);
    }

    opts.daemon!.emitArtifact(callerChatId, {
      artifactId,
      title: resolvedTitle,
      url,
      path: relPath,
    });
    toolLog({
      tool: 'patch_artifact',
      callerChatId,
      durationMs: Date.now() - start,
      ok: true,
    });
    return { ok: true, artifactId, url, title: resolvedTitle, path: relPath };
  });

  // patch_pad_* — design spaces the user edits (spec/14 § Pads). The host reads the
  // folder (Claude runs here) and the server owns the Pad. Create, update and
  // reply also stamp a Pad card into the chat (a `chat.artifact` whose id is
  // `pad-<padId>`), so the chat always carries a way into the Pad.
  app.post('/internal/pad', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = PadBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { op, callerChatId, dir, padId, name, app: appName, device, text, surface } = parsed.data;
    const state = opts.daemon!.chatState.get(callerChatId);
    if (!state) {
      return reply.code(404).send({
        error: 'chat_not_found',
        message: `chat not found: ${callerChatId}`,
      } satisfies ErrorEnvelope);
    }
    if (!opts.padRequest) {
      return reply.code(503).send({
        error: 'pads_unavailable',
        message: 'pads are not wired on this host',
      } satisfies ErrorEnvelope);
    }
    let result: unknown;
    try {
      if (op === 'create' && !name) throw new PadInputError('name is required');
      if ((op === 'update' || op === 'reply' || op === 'collect') && !padId)
        throw new PadInputError('padId is required');
      if (op === 'reply' && !text) throw new PadInputError('text is required');
      const files =
        op === 'create' || op === 'update' ? bundleDir(state.folder, dir ?? '') : undefined;
      result = await opts.padRequest({
        op,
        chatId: callerChatId,
        ...(padId !== undefined ? { padId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(appName !== undefined ? { app: appName } : {}),
        ...(device !== undefined ? { device } : {}),
        ...(files !== undefined ? { files } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(surface !== undefined ? { surface } : {}),
      });
      if (op === 'capture') result = saveCapture(state.folder, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const input = err instanceof PadInputError;
      toolLog({
        tool: `patch_pad_${op}`,
        callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: input ? 'invalid_input' : 'pad_failed',
      });
      return reply
        .code(input ? 400 : 502)
        .send({ error: input ? 'invalid_input' : 'pad_failed', message } satisfies ErrorEnvelope);
    }
    // A collect's evidence is the [Pad] message it delivers, as an editor Send's is.
    if (op === 'create' || op === 'update' || op === 'reply') {
      const pad = result as { id: string; name: string };
      opts.daemon!.emitArtifact(callerChatId, {
        artifactId: `pad-${pad.id}`,
        title: pad.name,
        url: `/pads/${pad.id}`,
        path: `pad:${pad.id}`,
      });
    }
    toolLog({ tool: `patch_pad_${op}`, callerChatId, durationMs: Date.now() - start, ok: true });
    return result;
  });

  // patch_meeting_notes — the agent adds to or edits the notes of the meeting
  // running in its own chat. A refusal (no meeting, unknown point, a figure with
  // no source) goes back to the agent as the error.
  app.post('/internal/meeting-notes', async (req, reply) => {
    if (require503(reply)) return;
    const body = req.body as { callerChatId?: unknown; edit?: unknown };
    const parsed = MeetingAgentNotesEdit.safeParse(body?.edit);
    if (typeof body?.callerChatId !== 'string' || !parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: parsed.success ? 'callerChatId is required' : parsed.error.message,
      } satisfies ErrorEnvelope);
    }
    if (!opts.meetingAgentEdit) {
      return reply.code(503).send({
        error: 'meetings_unavailable',
        message: 'meeting mode is not wired on this host',
      } satisfies ErrorEnvelope);
    }
    try {
      const label = opts.meetingAgentEdit(body.callerChatId, parsed.data);
      toolLog({
        tool: 'patch_meeting_notes',
        callerChatId: body.callerChatId,
        durationMs: 0,
        ok: true,
      });
      return { ok: true, changed: label };
    } catch (err) {
      toolLog({
        tool: 'patch_meeting_notes',
        callerChatId: body.callerChatId,
        durationMs: 0,
        ok: false,
        err: 'meeting_edit_failed',
      });
      return reply.code(409).send({
        error: 'meeting_edit_failed',
        message: (err as Error).message,
      } satisfies ErrorEnvelope);
    }
  });

  // view_file — put a file on the USER's screen (spec/14 § Tool calls).
  //
  // The distinction from Read is who the bytes are for: Read feeds Claude,
  // this feeds the user. So the file is published as a page (same server-side store
  // and sandboxed origin as an artifact) and the tool hands back only a small
  // ack naming where it went — the image never enters the model's context.
  // Unlike patch_artifact it does NOT stamp a chat.artifact card: the point is
  // that it renders inline where the call happened.
  app.post('/internal/view_file', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = ViewFileBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { file_path: filePath, callerChatId } = parsed.data;
    const state = opts.daemon!.chatState.get(callerChatId);
    if (!state) {
      return reply.code(404).send({
        error: 'chat_not_found',
        message: `chat not found: ${callerChatId}`,
      } satisfies ErrorEnvelope);
    }
    if (!opts.publishArtifact) {
      return reply.code(503).send({
        error: 'artifact_publisher_unavailable',
        message: 'view_file needs artifact publishing, which is not wired on this host',
      } satisfies ErrorEnvelope);
    }

    let relPath: string;
    let absPath: string;
    let kind: ViewFileKind;
    let size: { width: number; height: number } | undefined;
    let html: string | undefined;
    let raw: { contentType: string; base64: string; filename?: string } | undefined;
    let fileBytes: number | undefined;
    try {
      const configDir = opts.daemon!.chatConfigDir(callerChatId);
      const resolved = resolveViewFilePath(state.folder, filePath, configDir ? [configDir] : []);
      relPath = resolved.relPath;
      absPath = resolved.absPath;
      kind = resolved.kind;
      const stat = statSync(resolved.absPath);
      if (!stat.isFile()) throw new ArtifactInputError(`not a file: ${filePath}`);
      if (kind === 'image') {
        if (stat.size > MAX_VIEW_IMAGE_BYTES) {
          throw new ArtifactInputError(
            `image is ${stat.size} bytes — the limit is ${MAX_VIEW_IMAGE_BYTES}`,
          );
        }
        // Served byte-for-byte with its own content-type, NOT wrapped in an
        // HTML page: the frontend puts this URL straight into an `<img src>`
        // for the inline picture + zoom lightbox, which needs real image
        // bytes to decode — an HTML document at that URL is a broken image
        // icon, whatever markup it wraps around a data URI.
        const imageBytes = readFileSync(resolved.absPath);
        raw = { contentType: resolved.mime, base64: imageBytes.toString('base64') };
        // The ack carries the picture's real size so the chat can reserve its
        // box before the <img> loads. Without it the transcript reflows as
        // each image lands, which is half of what "it scrolls through the
        // messages one by one" looks like.
        size = imageSize(imageBytes);
      } else if (kind === 'pdf' || kind === 'audio') {
        if (stat.size > MAX_VIEW_PDF_BYTES) {
          throw new ArtifactInputError(
            `${kind} is ${stat.size} bytes — the limit is ${MAX_VIEW_PDF_BYTES}`,
          );
        }
        // Served byte-for-byte with its own content-type, NOT wrapped in an
        // HTML page: the browser's PDF viewer will not start inside a
        // sandboxed frame (which a wrapper page always is), and an audio
        // player needs real audio bytes at its `src`.
        raw = {
          contentType: resolved.mime,
          base64: readFileSync(resolved.absPath).toString('base64'),
        };
      } else if (kind === 'video') {
        if (stat.size > MAX_VIEW_VIDEO_BYTES) {
          throw new ArtifactInputError(
            `video is ${stat.size} bytes — the limit is ${MAX_VIEW_VIDEO_BYTES}`,
          );
        }
        // Served byte-for-byte with its own content-type: the chat puts this
        // URL straight into a `<video src>`.
        raw = {
          contentType: resolved.mime,
          base64: readFileSync(resolved.absPath).toString('base64'),
        };
        fileBytes = stat.size;
      } else if (kind === 'file') {
        if (stat.size > MAX_VIEW_FILE_BYTES) {
          throw new ArtifactInputError(
            `file is ${stat.size} bytes — the limit is ${MAX_VIEW_FILE_BYTES}`,
          );
        }
        // Served byte-for-byte as an attachment under its own name: the chat
        // shows a download card, not a frame.
        raw = {
          contentType: resolved.mime,
          base64: readFileSync(resolved.absPath).toString('base64'),
          filename: basename(resolved.relPath),
        };
        fileBytes = stat.size;
      } else {
        if (stat.size > MAX_ARTIFACT_BYTES) {
          throw new ArtifactInputError(
            `page is ${stat.size} bytes — the limit is ${MAX_ARTIFACT_BYTES}`,
          );
        }
        const source = readFileSync(resolved.absPath, 'utf8');
        if (source.trim().length === 0) throw new ArtifactInputError(`file is empty: ${filePath}`);
        html = toDocument(source, basename(relPath));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const notFound =
        (err as NodeJS.ErrnoException).code === 'ENOENT' ||
        (err as NodeJS.ErrnoException).code === 'ENOTDIR';
      toolLog({
        tool: 'view_file',
        callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: notFound ? 'not_found' : 'invalid_input',
      });
      return reply.code(notFound ? 404 : 400).send({
        error: notFound ? 'view_file_not_found' : 'invalid_input',
        message: notFound ? `file not found in the chat folder: ${filePath}` : message,
      } satisfies ErrorEnvelope);
    }

    // Namespaced away from `patch_artifact`'s id for the same path, so viewing
    // a page never overwrites the artifact card published from it.
    const viewId = artifactIdFor(callerChatId, `view_file\u0000${relPath}`);
    const name = basename(relPath);
    let url: string;
    try {
      const published = await opts.publishArtifact({
        chatId: callerChatId,
        artifactId: viewId,
        title: name,
        path: relPath,
        ...(html !== undefined ? { html } : {}),
        ...(raw !== undefined ? { raw } : {}),
      });
      url = published.url;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolLog({
        tool: 'view_file',
        callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'publish_failed',
      });
      return reply
        .code(502)
        .send({ error: 'view_file_publish_failed', message } satisfies ErrorEnvelope);
    }

    // A downloadable file also gets an inline preview page, published under its
    // own id. A previewable file whose page cannot be built still succeeds as a
    // download card, but the ack says why there is no preview.
    let previewUrl: string | undefined;
    let previewError: string | undefined;
    if (kind === 'file') {
      const ext = extname(relPath).toLowerCase();
      if (previewable(ext)) {
        try {
          const previewHtml = await buildPreviewHtml(absPath, ext, name);
          const published = await opts.publishArtifact({
            chatId: callerChatId,
            artifactId: artifactIdFor(callerChatId, `view_file_preview\u0000${relPath}`),
            title: name,
            path: relPath,
            html: previewHtml,
          });
          previewUrl = published.url;
        } catch (err) {
          previewError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    toolLog({ tool: 'view_file', callerChatId, durationMs: Date.now() - start, ok: true });
    return {
      ok: true,
      shown: true,
      kind,
      url,
      name,
      path: relPath,
      // Where the file sits on this host: the desktop app opens it from here.
      absPath,
      ...(previewUrl !== undefined ? { previewUrl } : {}),
      ...(previewError !== undefined ? { previewError } : {}),
      ...(size ?? {}),
      ...(fileBytes !== undefined ? { size: fileBytes } : {}),
    };
  });

  // link_file — point the USER at a file that lives on this host's disk, wherever
  // it is. Nothing is read, copied or published: the ack is the name, absolute
  // path and size, and the desktop app opens it from there (open file / show in
  // folder) when its own host owns the chat. A missing path is a loud 404.
  app.post('/internal/link_file', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = LinkFileBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { file_path: filePath, callerChatId } = parsed.data;
    if (!opts.daemon!.chatState.get(callerChatId)) {
      return reply.code(404).send({
        error: 'chat_not_found',
        message: `chat not found: ${callerChatId}`,
      } satisfies ErrorEnvelope);
    }
    const expanded =
      filePath === '~' || filePath.startsWith('~/') ? join(homedir(), filePath.slice(1)) : filePath;
    if (!isAbsolute(expanded)) {
      toolLog({
        tool: 'link_file',
        callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'invalid_input',
      });
      return reply.code(400).send({
        error: 'invalid_input',
        message: `link_file needs an absolute path (or one starting with ~/): ${filePath}`,
      } satisfies ErrorEnvelope);
    }
    const absPath = resolve(expanded);
    let stat: Stats;
    try {
      stat = statSync(absPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const notFound = code === 'ENOENT' || code === 'ENOTDIR';
      toolLog({
        tool: 'link_file',
        callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: notFound ? 'not_found' : 'invalid_input',
      });
      return reply.code(notFound ? 404 : 400).send({
        error: notFound ? 'link_file_not_found' : 'invalid_input',
        message: notFound
          ? `nothing at ${absPath}`
          : `cannot read ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies ErrorEnvelope);
    }
    // A previewable file also gets the same inline preview page a view_file
    // card has, published from here (the file is on this host's disk). A
    // preview that cannot be built leaves the link intact and says why.
    let previewUrl: string | undefined;
    let previewError: string | undefined;
    const ext = extname(absPath).toLowerCase();
    if (stat.isFile() && previewable(ext)) {
      try {
        if (!opts.publishArtifact) {
          throw new Error('artifact publishing is not wired on this host');
        }
        const previewHtml = await buildPreviewHtml(absPath, ext, basename(absPath));
        const published = await opts.publishArtifact({
          chatId: callerChatId,
          artifactId: artifactIdFor(callerChatId, `link_file_preview\u0000${absPath}`),
          title: basename(absPath),
          path: basename(absPath),
          html: previewHtml,
        });
        previewUrl = published.url;
      } catch (err) {
        previewError = err instanceof Error ? err.message : String(err);
      }
    }
    toolLog({ tool: 'link_file', callerChatId, durationMs: Date.now() - start, ok: true });
    return {
      ok: true,
      linked: true,
      kind: 'link',
      name: basename(absPath),
      absPath,
      isDirectory: stat.isDirectory(),
      ...(stat.isFile() ? { size: stat.size } : {}),
      ...(previewUrl !== undefined ? { previewUrl } : {}),
      ...(previewError !== undefined ? { previewError } : {}),
    };
  });

  // patch_notify.
  app.post('/internal/notify', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = NotifyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { channel, message, priority, deviceId, deepLink, quickReplies, callerChatId } =
      parsed.data;
    if (!limiter.check(`notify:${callerChatId}`)) {
      toolLog({
        tool: 'patch_notify',
        callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'rate_limited',
      });
      return sendRateLimited(reply, `notify:${callerChatId}`);
    }
    if (!opts.daemon!.chatState.has(callerChatId)) {
      return reply.code(404).send({
        error: 'chat_not_found',
        message: `chat not found: ${callerChatId}`,
      } satisfies ErrorEnvelope);
    }
    // A notification takes its chat out of Archived only (spec/04 § Current
    // status). It never unhides: Hidden is the user's call.
    opts.daemon!.unarchiveForNotify(callerChatId);
    if (opts.emitWire) {
      const event: WireEvent = {
        type: 'notify',
        chatId: callerChatId,
        ...(channel !== undefined ? { channel } : {}),
        message,
        ...(priority !== undefined ? { priority } : {}),
        ...(deviceId !== undefined ? { deviceId } : {}),
        ...(deepLink !== undefined ? { deepLink } : {}),
        ...(quickReplies !== undefined && quickReplies.length > 0
          ? { actions: { kind: 'message' as const, quickReplies } }
          : {}),
      };
      opts.emitWire(event);
    }
    // Per spec/06 + spec/09 broadcast sidecar:
    // when a non-thread chat fires patch_notify on a thread channel, the
    // message is appended to the special thread's broadcasts.jsonl.
    // Only a notify that NAMED a thread-mediated channel belongs in that
    // thread's broadcast log. A routed one did not choose speakers,
    // so it is not context for that thread.
    if (opts.onBroadcast && channel !== undefined) {
      opts.onBroadcast({ channel, message, sourceChatId: callerChatId });
    }
    // A speakers notify needs nothing more here: the server speaks it on a
    // connected voice device, or pushes it (spec/09 § speakers, spec/16).
    toolLog({
      tool: 'patch_notify',
      callerChatId,
      durationMs: Date.now() - start,
      ok: true,
    });
    // A snoozed chat is silent on every channel (spec/09 § Snoozed chats): the
    // server drops the event above. Say so, or the agent believes the user was
    // asked and waits for a reply nobody was prompted to give.
    if (isSnoozedNow(opts.daemon!.chatState.get(callerChatId))) return NOT_DELIVERED_SNOOZED;
    return { ok: true };
  });

  // patch_ask_human. The escalation that permissions and questions do not
  // cover: the agent is blocked until a person does something in the physical
  // world -- grant a permission macOS will only take by hand, plug a cable in,
  // put the bins out. It is not a decision to make and not a tool to approve,
  // so neither existing path fits, and without this an agent in that position
  // can only write into a chat nobody is looking at.
  app.post('/internal/ask_human', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = AskHumanBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { task, why, resumeAt, callerChatId } = parsed.data;
    if (!limiter.check(`ask_human:${callerChatId}`)) {
      toolLog({
        tool: 'patch_ask_human',
        callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'rate_limited',
      });
      return sendRateLimited(reply, `ask_human:${callerChatId}`);
    }
    const state = opts.daemon!.chatState.get(callerChatId);
    if (!state) {
      return reply.code(404).send({
        error: 'chat_not_found',
        message: `chat not found: ${callerChatId}`,
      } satisfies ErrorEnvelope);
    }
    // Blocked on a person is the definition of "cannot stay hidden" — and it is
    // the same fact about the chat as an unanswered question, so it is recorded
    // as one. `declareStatus` persists it and un-archives; the task text becomes
    // the line the row shows, which is why it is written as an instruction the
    // user could follow without opening the chat.
    //
    // This used to un-archive and nothing else, so the task existed only inside
    // a notification that had already gone. Miss the push and the chat read as
    // idle like every other — the one chat in a month that genuinely needed a
    // person, indistinguishable from the ones that merely finished.
    await opts.daemon!.declareStatus(callerChatId, 'question', task);
    // An armed goal waits too, rather than being judged impossible meanwhile.
    opts.daemon!.holdGoalForUser(callerChatId, resumeAt);
    if (opts.emitWire) {
      const event: WireEvent = {
        type: 'notify',
        chatId: callerChatId,
        channel: 'push',
        kind: 'ask',
        message: `${state.name ?? 'A chat'} needs you to: ${task}`,
        priority: 'normal',
      };
      opts.emitWire(event);
    }
    app.log.info({ chatId: callerChatId, task, why }, 'patch_ask_human: blocked on the user');
    toolLog({ tool: 'patch_ask_human', callerChatId, durationMs: Date.now() - start, ok: true });
    if (isSnoozedNow(state)) return NOT_DELIVERED_SNOOZED;
    return { ok: true };
  });

  // patch_ask_human with done:true. The agent can see the action it asked for
  // has happened, so it clears its own ask: same effect as the user's Done,
  // minus the "Done: <task>" turn (the agent is the one running).
  app.post('/internal/ask_human_done', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = AskHumanDoneBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { callerChatId } = parsed.data;
    if (!opts.daemon!.chatState.get(callerChatId)) {
      return reply.code(404).send({
        error: 'chat_not_found',
        message: `chat not found: ${callerChatId}`,
      } satisfies ErrorEnvelope);
    }
    try {
      await opts.daemon!.resolveAsk(callerChatId, 'agent');
    } catch (e) {
      return reply
        .code(409)
        .send({ error: 'no_pending_ask', message: (e as Error).message } satisfies ErrorEnvelope);
    }
    toolLog({ tool: 'patch_ask_human', callerChatId, durationMs: Date.now() - start, ok: true });
    return { ok: true };
  });

  // patch_report. The third way into the sidebar, and the ONLY one an agent
  // elects for itself: a permission is a request the platform is holding and a
  // question is the chat being stuck, but a report is a judgement — "of the
  // twenty things that ran overnight, this is one of the ones worth your
  // morning". Nothing is blocked and nothing is asked; the chat simply stops
  // being hidden and carries a line saying why.
  //
  // It makes no sound. That is the point of having it: a hidden job's only
  // routes out used to be a block or a notification, so anything worth seeing
  // later had to either interrupt or stay invisible.
  app.post('/internal/report', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = ReportBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { summary, callerChatId } = parsed.data;
    if (!limiter.check(`report:${callerChatId}`)) {
      toolLog({
        tool: 'patch_report',
        callerChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'rate_limited',
      });
      return sendRateLimited(reply, `report:${callerChatId}`);
    }
    if (!opts.daemon!.chatState.has(callerChatId)) {
      return reply.code(404).send({
        error: 'chat_not_found',
        message: `chat not found: ${callerChatId}`,
      } satisfies ErrorEnvelope);
    }
    await opts.daemon!.declareStatus(callerChatId, 'report', summary);
    app.log.info({ chatId: callerChatId, summary }, 'patch_report: worth the user seeing');
    toolLog({ tool: 'patch_report', callerChatId, durationMs: Date.now() - start, ok: true });
    return { ok: true };
  });

  // patch_call.
  app.post('/internal/call', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = CallBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { callerChatId } = parsed.data;
    const targetChatId = parsed.data.chatId ?? callerChatId;
    if (!limiter.check(`call:${callerChatId}`)) {
      toolLog({
        tool: 'patch_call',
        callerChatId,
        targetChatId,
        durationMs: Date.now() - start,
        ok: false,
        err: 'rate_limited',
      });
      return sendRateLimited(reply, `call:${callerChatId}`);
    }
    if (!opts.daemon!.chatState.has(targetChatId)) {
      return reply.code(404).send({
        error: 'chat_not_found',
        message: `chat not found: ${targetChatId}`,
      } satisfies ErrorEnvelope);
    }
    // spec/07 § Agent-initiated voice — the user has turned agent calls off:
    // nothing rings, nothing is spoken, and the agent is told why.
    if (opts.agentsCanCall?.() === false) {
      toolLog({
        tool: 'patch_call',
        callerChatId,
        targetChatId,
        durationMs: Date.now() - start,
        ok: true,
        err: 'calls_off',
      });
      return {
        ok: true,
        rang: false,
        message:
          'The user has turned off agent calls (Settings → Voice calls), so nothing rang. Reach them another way if it matters.',
      };
    }
    // spec/07 § Agent-initiated voice: a session already open takes the message
    // as speech at the next pause — ringing a surface the user is demonstrably
    // already on would be the wrong doorbell. This is also the ONLY way a quiet
    // hands-free session ever speaks (spec/07 § Session modes).
    const spokenIntoOpenCall =
      parsed.data.message !== undefined && parsed.data.message.trim() !== ''
        ? (opts.interruptOpenCall?.(parsed.data.message) ?? false)
        : false;
    if (opts.emitWire && !spokenIntoOpenCall) {
      const event: WireEvent = {
        type: 'patch.call',
        chatId: targetChatId,
        ...(parsed.data.message !== undefined ? { message: parsed.data.message } : {}),
      };
      opts.emitWire(event);
    }
    toolLog({
      tool: 'patch_call',
      callerChatId,
      targetChatId,
      durationMs: Date.now() - start,
      ok: true,
    });
    return { ok: true, spokenIntoOpenCall };
  });

  // patch_end_call.
  app.post('/internal/end_call', async (req, reply) => {
    const start = Date.now();
    if (require503(reply)) return;
    const parsed = EndCallBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    const { callerChatId } = parsed.data;
    const targetChatId = parsed.data.chatId ?? callerChatId;
    if (!opts.endOpenCall) {
      return reply.code(503).send({
        error: 'voice_unavailable',
        message: 'this host runs no audio server, so it has no call to end',
      } satisfies ErrorEnvelope);
    }
    const ended = await opts.endOpenCall(targetChatId, parsed.data.message);
    toolLog({
      tool: 'patch_end_call',
      callerChatId,
      targetChatId,
      durationMs: Date.now() - start,
      ok: true,
    });
    return { ok: true, ended };
  });

  // patch_job_list.
  app.get('/internal/jobs', async (_req, reply) => {
    const start = Date.now();
    if (!opts.jobs) return reply.code(503).send({ error: 'jobs not configured' });
    try {
      const jobs = await opts.jobs.list();
      toolLog({ tool: 'patch_job_list', durationMs: Date.now() - start, ok: true });
      return { jobs };
    } catch (err) {
      if (err instanceof JobsLinkOfflineError) {
        return reply.code(503).send({ error: 'link_offline', message: err.message });
      }
      throw err;
    }
  });

  // patch_job_create.
  app.post('/internal/jobs', async (req, reply) => {
    const start = Date.now();
    if (!opts.jobs) return reply.code(503).send({ error: 'jobs not configured' });
    const parsed = JobCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    try {
      const job = await opts.jobs.create(parsed.data);
      toolLog({ tool: 'patch_job_create', durationMs: Date.now() - start, ok: true });
      return { jobId: job.id, job };
    } catch (err) {
      if (err instanceof JobsLinkOfflineError) {
        return reply.code(503).send({ error: 'link_offline', message: err.message });
      }
      // Semantic validation failure (bad cron / JSONata) surfaced by the
      // server's canonical store — same single gate the REST surface hits.
      if ((err as Error).name === 'JobInvalidInputError') {
        return reply.code(400).send({ error: 'invalid_input', message: (err as Error).message });
      }
      throw err;
    }
  });

  // patch_job_update.
  app.patch<{ Params: { id: string } }>('/internal/jobs/:id', async (req, reply) => {
    const start = Date.now();
    if (!opts.jobs) return reply.code(503).send({ error: 'jobs not configured' });
    const parsed = JobUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    try {
      const job = await opts.jobs.patch(req.params.id, parsed.data);
      toolLog({ tool: 'patch_job_update', durationMs: Date.now() - start, ok: true });
      return { job };
    } catch (err) {
      if (err instanceof JobNotFoundError || (err as Error).name === 'JobNotFoundError') {
        return reply.code(404).send({ error: 'job_not_found', message: (err as Error).message });
      }
      if (err instanceof JobsLinkOfflineError) {
        return reply.code(503).send({ error: 'link_offline', message: err.message });
      }
      if ((err as Error).name === 'JobInvalidInputError') {
        return reply.code(400).send({ error: 'invalid_input', message: (err as Error).message });
      }
      throw err;
    }
  });

  // patch_job_delete.
  app.delete<{ Params: { id: string } }>('/internal/jobs/:id', async (req, reply) => {
    const start = Date.now();
    if (!opts.jobs) return reply.code(503).send({ error: 'jobs not configured' });
    try {
      const ok = await opts.jobs.delete(req.params.id);
      if (!ok) return reply.code(404).send({ error: 'job_not_found' });
      toolLog({ tool: 'patch_job_delete', durationMs: Date.now() - start, ok: true });
      return { ok: true };
    } catch (err) {
      if (err instanceof JobNotFoundError || (err as Error).name === 'JobNotFoundError') {
        return reply.code(404).send({ error: 'job_not_found', message: (err as Error).message });
      }
      if (err instanceof JobsLinkOfflineError) {
        return reply.code(503).send({ error: 'link_offline', message: err.message });
      }
      throw err;
    }
  });

  // patch_job_enable / disable.
  app.post<{ Params: { id: string } }>('/internal/jobs/:id/enable', async (req, reply) => {
    if (!opts.jobs) return reply.code(503).send({ error: 'jobs not configured' });
    try {
      const job = await opts.jobs.enable(req.params.id);
      return { job };
    } catch (err) {
      if (err instanceof JobNotFoundError || (err as Error).name === 'JobNotFoundError') {
        return reply.code(404).send({ error: 'job_not_found', message: (err as Error).message });
      }
      if (err instanceof JobsLinkOfflineError) {
        return reply.code(503).send({ error: 'link_offline', message: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/internal/jobs/:id/runs',
    async (req, reply) => {
      if (!opts.jobs) return reply.code(503).send({ error: 'jobs not configured' });
      // Validate input before probing backend capability — a malformed limit is
      // a client error regardless of which store backs the route.
      const limitResult = parseRunsLimit(req.query?.limit);
      if (!limitResult.ok) {
        return reply.code(400).send({ error: 'invalid_input', message: limitResult.message });
      }
      const remote = opts.jobs as { runs?: (id: string, limit?: number) => Promise<unknown[]> };
      if (typeof remote.runs !== 'function') {
        return reply.code(501).send({ error: 'runs not supported by this jobs store' });
      }
      try {
        const limit = limitResult.value;
        const runs = await remote.runs(req.params.id, limit);
        return { runs };
      } catch (err) {
        if (err instanceof JobsLinkOfflineError) {
          return reply.code(503).send({ error: 'link_offline', message: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/internal/jobs/:id/webhooks',
    async (req, reply) => {
      if (!opts.jobs) return reply.code(503).send({ error: 'jobs not configured' });
      const limitResult = parseRunsLimit(req.query?.limit);
      if (!limitResult.ok) {
        return reply.code(400).send({ error: 'invalid_input', message: limitResult.message });
      }
      const remote = opts.jobs as {
        webhooks?: (id: string, limit?: number) => Promise<unknown[]>;
      };
      if (typeof remote.webhooks !== 'function') {
        return reply.code(501).send({ error: 'webhooks not supported by this jobs store' });
      }
      try {
        const limit = limitResult.value;
        const webhooks = await remote.webhooks(req.params.id, limit);
        return { webhooks };
      } catch (err) {
        if (err instanceof JobsLinkOfflineError) {
          return reply.code(503).send({ error: 'link_offline', message: err.message });
        }
        throw err;
      }
    },
  );

  // Group 19: /internal/files/:chatId?path=<rel> — list directory entries
  // under the chat's pinned folder. Sandbox: any traversal escape returns
  // 400. Read-only; surfaces use this for the file-browser tree.
  app.get<{ Params: { chatId: string }; Querystring: { path?: string } }>(
    '/internal/files/:chatId',
    async (req, reply) => {
      if (require503(reply)) return;
      const state = opts.daemon!.chatState.get(req.params.chatId);
      if (!state) {
        return reply.code(404).send({
          error: 'chat_not_found',
          message: `chat not found: ${req.params.chatId}`,
        } satisfies ErrorEnvelope);
      }
      const root = resolve(state.folder);
      const rel = (req.query?.path ?? '').replace(/^\/+/, '');
      // Strict traversal check.
      const target = resolve(join(root, rel));
      if (target !== root && !target.startsWith(root + sep)) {
        return reply
          .code(400)
          .send({ error: 'path_escape', message: 'path escapes the chat folder' });
      }
      let entries: { name: string; type: 'file' | 'dir'; size?: number }[];
      try {
        const dirents = readdirSync(target, { withFileTypes: true });
        // Dotfiles ARE listed — see the matching comment in index.ts's
        // handleFilesRequest, the primary path for this same file-browser tree.
        entries = dirents.map((d) => {
          if (d.isDirectory()) return { name: d.name, type: 'dir' as const };
          const full = join(target, d.name);
          const size = statSync(full).size;
          return { name: d.name, type: 'file' as const, size };
        });
      } catch (err) {
        return reply.code(404).send({
          error: 'not_found',
          message: (err as Error).message,
        });
      }
      return { path: rel, entries };
    },
  );

  app.post<{ Params: { id: string } }>('/internal/jobs/:id/disable', async (req, reply) => {
    if (!opts.jobs) return reply.code(503).send({ error: 'jobs not configured' });
    try {
      const job = await opts.jobs.disable(req.params.id);
      return { job };
    } catch (err) {
      if (err instanceof JobNotFoundError || (err as Error).name === 'JobNotFoundError') {
        return reply.code(404).send({ error: 'job_not_found', message: (err as Error).message });
      }
      if (err instanceof JobsLinkOfflineError) {
        return reply.code(503).send({ error: 'link_offline', message: err.message });
      }
      throw err;
    }
  });

  return app;
}
