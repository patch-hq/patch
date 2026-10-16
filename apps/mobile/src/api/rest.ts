// REST client. Mirrors packages/web/src/api/rest.ts surface so screens
// share the same call shape. NO FALLBACK — any non-2xx is thrown.

import { assertVersionReport } from '@patch/wire';
import type {
  SnoozeRecord,
  DocAction,
  DocView,
  AccountStrategy,
  ChatContextUsage,
  AuthOkHost,
  ProviderKeyId,
  SettingsChangedEvent,
  SharedSettings,
  AttachmentRef,
  ChatSearchResponse,
  PendingWake,
  PermissionMode,
  VersionReport,
  StatusKind,
  TodoItem,
  WatchTaskRow,
  UsageSample,
  ChatTokenUsage,
} from '@patch/wire';
import type { Hook, HookCreateBody, HookPatchBody } from '@patch/wire/hooks';
import { loadCredential } from '../lib/credential';
import { bytesToBase64 } from '../lib/base64';
import { apiUrl } from '../config';

/** One row of a host directory listing (spec/03 § Host files). */
export interface HostFileEntry {
  name: string;
  /** A symlink is listed as what it points at; a dangling one is `other`. */
  type: 'file' | 'dir' | 'other';
  size?: number;
}

/** An uploaded attachment: the wire ref plus the relative URL to render it inline. */
export type UploadedAttachment = AttachmentRef & { url: string };

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

interface RequestInit2 extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * The message for a non-2xx body. Server failures that originate on the host
 * come back as `{error: <code>, message: <detail>}`; a bare code ("internal")
 * tells the user nothing, so the detail is carried through when present.
 */
export function errorMessageFrom(parsed: unknown, status: number): string {
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const code = obj && 'error' in obj ? String(obj.error) : `HTTP ${status}`;
  const detail = obj && typeof obj.message === 'string' ? obj.message : null;
  // A voice surface with no provider key on its host: the host's message is
  // the complete sentence (key, host, Settings → Voice), shown as is.
  if (code === 'voice_key_missing' && detail) return detail;
  return detail ? `${code}: ${detail}` : code;
}

async function request<T>(path: string, init: RequestInit2 = {}): Promise<T> {
  const headers = new Headers(init.headers as HeadersInit | undefined);
  const cred = loadCredential();
  if (cred) headers.set('authorization', `Bearer ${cred}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(apiUrl(path), {
    ...init,
    headers,
    body: init.body === undefined ? null : JSON.stringify(init.body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, errorMessageFrom(parsed, res.status), parsed);
  }
  return parsed as T;
}

export interface ChatListEntry {
  chatId: string;
  name: string | null;
  /** The host the chat runs on (spec/04 § Spawn) — paths are scoped to it. */
  hostId: string;
  folder: string;
  activity: 'idle' | 'running' | 'awaiting-permission' | 'errored';
  /** The effective mode the chat's next turn will use (spec/02 § Permission mode). */
  permissionMode: PermissionMode;
  status: 'active' | 'archived' | 'errored';
  pinned: boolean;
  pinnedAt: number | null;
  lastUpdated: number;
  /**
   * ms epoch of the user's own last activity on this chat (spec/14 § Sidebar
   * ordering) — what the Chats tab sorts by instead of `lastUpdated`.
   * Optional because an older server does not send it; the store falls back
   * to `lastUpdated`.
   */
  lastUserActivity?: number;
  /** The chat's pending self-wake (spec/02 § Self-wake), for cold-start (§ chatStore). */
  pendingWake: PendingWake | null;
  /**
   * Wake time of a snooze (spec/04 § Snooze), ms epoch, or `null`. Present only
   * because the phone asks for `?snoozed=include`; a snoozed chat is drawn in
   * its own section rather than hidden, so the roster has to carry it.
   */
  snoozedUntil: number | null;
  /** What each snooze was and what happened in it (spec/04 § Snooze). */
  snoozeRecords?: SnoozeRecord[];
  /** ms epoch the current run began, or null. */
  runningSince?: number | null;
  /**
   * Running out of the active list (spec/04 § Hidden). Only `?hidden=only`
   * returns a hidden chat — the default roster leaves them out. Optional: an
   * older server does not send the field.
   */
  hidden?: boolean;
  /** How full the chat's context window is (spec/14 § Composer — context ring). */
  context?: ChatContextUsage | null;
  /**
   * The model the chat's next turn runs on (spec/04 § Model), or `null` when
   * its host reports none. Optional: an older server does not send the field.
   */
  model?: string | null;
  /**
   * The job whose action created the chat (spec/08 § Action), or `null` for a
   * chat a person started. Optional: an older server does not send the field.
   */
  jobId?: string | null;
  /**
   * The chat's status summary and kind (spec/06 § The watch loop) — what the
   * Manager's Chats tab ranks and describes rows by. Optional: an older server
   * does not send them.
   */
  statusSummary?: string | null;
  statusKind?: StatusKind | null;
  statusDeclared?: boolean | null;
  /** The chat's goal (`/goal`), or `null`. Optional: an older server omits it. */
  goal?: string | null;
  /** The chat's reminder (`/remind`), or `null`. Optional, as `goal`. */
  reminder?: string | null;
  /** The agent's task list (spec/02 § Task list). Optional, as `goal`. */
  todos?: TodoItem[];
  /** A special thread turned off (spec/06 § Disabled). Optional, as `goal`. */
  disabled?: boolean;
}

/**
 * The shared settings (spec/01 § Settings): held on the server, sent to every
 * host, and the same on every surface.
 */
export type AccountPreferences = SharedSettings;

/** What a shared-settings write answers with: the committed state. */
export type SharedState = Omit<SettingsChangedEvent, 'type'>;

export interface WebBotAuthStatus {
  ready: boolean;
  issue: string | null;
  origin: string;
  agentUrl: string;
  directoryUrl: string;
  keyId: string;
}

/** The backends whose accounts are shared settings. */
export type SharedBackendId = 'claude-code' | 'codex';

/** A linked surface as `/api/settings` lists it (Settings → Linked devices). */
export interface LinkedDevice {
  surfaceId: string;
  surfaceKind: string;
  label: string;
  issuedAt: number;
  status: 'online' | 'stale' | 'offline';
  lastHeartbeat: number | null;
  isCurrent: boolean;
}

/** GET /api/settings — the same payload web's Settings page reads. */
export interface SettingsResponse {
  devices: LinkedDevice[];
  push: { tokenCount: number };
  preferences: AccountPreferences;
  /** Secrets as source and last four only, and each host's applied version. */
  shared?: Omit<SharedState, 'settings'>;
}

export type VoiceBackend = 'local' | 'gemini' | 'openai';
export type VoiceLayer = 'direct' | 'light' | 'heavy';
export type VoiceHandoff = 'auto' | 'always' | 'never';
export interface VoiceSurfaceConfig {
  backend: VoiceBackend;
  layer: VoiceLayer;
  handoff: VoiceHandoff;
}

/** One Pad as the server serves it (spec/14 § Pads). */
export interface PadView {
  id: string;
  name: string;
  /** The app the Pad designs for, or null for a blank one. */
  app: string | null;
  chatId: string;
  device: 'desktop' | 'phone';
  createdAt: number;
  updatedAt: number;
  pending: number;
  /** A batch was sent and the agent has not replied yet. */
  working: boolean;
  screens: { id: string; name: string; path: string; pending: number }[];
  screensError: string | null;
  /** Signed, relative URL of the editor page. */
  frameUrl: string;
}

/** One screen of an earlier Pad, offered as a starting point for a new one. */
export interface PadLibraryScreen {
  padId: string;
  screenId: string;
  name: string;
  /** Signed, relative URL of the thumbnail, or null before one is rendered. */
  thumbUrl: string | null;
  device: 'desktop' | 'phone';
}
export interface PadLibrary {
  apps: { app: string; screens: PadLibraryScreen[] }[];
}
export interface PadCreateBody {
  name: string;
  app?: string;
  device: 'desktop' | 'phone';
  chatId: string;
  /** Screens captured from the live app: each one self-contained HTML. */
  screens?: { name: string; html: string; width?: number }[];
  /** Screens of earlier Pads to start from. */
  from?: { padId: string; screenId: string }[];
}
/** GET /api/link-preview — the OpenGraph summary of a link in a message. */
export interface LinkPreviewData {
  url: string;
  title?: string;
  description?: string;
  image?: string;
}

/** spec/06 § Sweep — one completed sweep run. */
export interface SweepRun {
  at: number;
  runId: string;
  candidateCount: number;
  actions: { chatId: string; action: 'nudge' | 'wake' | 'flag' | 'leave' }[];
  tokensUsed: number;
  error?: string;
}

export type ComputerUseHost = {
  hostId: string;
  name: string | null;
  active?: boolean;
  actionLabel?: string;
  since?: number;
  tabs?: number;
  lastStoppedAt?: number;
  closed?: number;
  /** Present when the machine did not answer. */
  error?: string;
};

export const api = {
  /** Settings → Usage: probe history and per-chat token totals for a window. */
  usageReport: (params: { since: number; until: number }) =>
    request<{
      samples: (UsageSample & { hostId: string })[];
      chats: (ChatTokenUsage & { hostId: string })[];
    }>(`/api/usage-report?since=${params.since}&until=${params.until}`),
  webBotAuthStatus: () => request<WebBotAuthStatus>('/api/web-bot-auth'),
  getSweepRuns: (limit?: number) =>
    request<{ runs: SweepRun[] }>(`/api/manager/sweeps${limit ? `?limit=${limit}` : ''}`),
  checkSweepNow: () =>
    request<{ fired: boolean }>('/api/manager/sweep/check-now', { method: 'POST' }),
  listPads: () => request<{ pads: PadView[] }>('/api/pads'),
  getPad: (id: string) => request<PadView>(`/api/pads/${encodeURIComponent(id)}`),
  padLibrary: () => request<PadLibrary>('/api/pads/library'),
  createPad: (body: PadCreateBody) => request<PadView>('/api/pads', { method: 'POST', body }),
  linkPreview: (url: string) =>
    request<LinkPreviewData>(`/api/link-preview?url=${encodeURIComponent(url)}`),
  patchPad: (id: string, body: { name?: string; device?: 'desktop' | 'phone' }) =>
    request<PadView>(`/api/pads/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deletePad: (id: string) =>
    request<null>(`/api/pads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Settings → Computer use: is an agent driving each machine's browser. */
  computerUse: () => request<{ hosts: ComputerUseHost[] }>('/api/browser-use'),
  stopComputerUse: (hostId: string) =>
    request<ComputerUseHost>(`/api/browser-use/${encodeURIComponent(hostId)}/stop`, {
      method: 'POST',
    }),
  // spec/20-hooks.md — hook CRUD (the pre-send check is lib/hookCheck.ts).
  listHooks: () => request<{ hooks: Hook[] }>('/api/hooks'),
  createHook: (body: HookCreateBody) => request<Hook>('/api/hooks', { method: 'POST', body }),
  patchHook: (id: string, body: HookPatchBody) =>
    request<Hook>(`/api/hooks/${id}`, { method: 'PATCH', body }),
  deleteHook: (id: string) => request<void>(`/api/hooks/${id}`, { method: 'DELETE' }),
  enableHook: (id: string) => request<Hook>(`/api/hooks/${id}/enable`, { method: 'POST' }),
  disableHook: (id: string) => request<Hook>(`/api/hooks/${id}/disable`, { method: 'POST' }),
  // GET /api/auth/me — the server returns the account + surface NESTED
  // (matches packages/server auth-routes `{ account, surface }`). A flat
  // `{accountId, surfaceId}` shape would read `undefined` identity into the
  // voice session_start frame and the host would reject the session as
  // "token does not bind to declared identity".
  me: () =>
    request<{
      account: { accountId: string; userPublicKey: string; createdAt: number };
      surface: { surfaceId: string; surfaceKind: string; label: string; issuedAt: number };
    }>('/api/auth/me'),
  // GET /api/settings — the same payload web's Settings page reads: linked
  // devices, push count, and the account-wide preferences (spec/14 §
  // `/settings` details).
  settings: (signal?: AbortSignal) =>
    request<SettingsResponse>('/api/settings', signal ? { signal } : {}),
  // GET /api/healthz — the server this surface is actually talking to and its
  // commit, for Settings → Connection (spec/14 § Account & connection).
  healthz: () => request<{ ok: boolean; version: string; gitSha: string }>('/api/healthz'),
  // GET /api/version — every layer's build plus any drift between them
  // (spec/11 § Version reporting), for Settings → Version & updates details.
  // Validated at the boundary, as on web: a partial report must reach the
  // panel's error state, not render as "all layers agree".
  version: async (): Promise<VersionReport> =>
    assertVersionReport(await request<unknown>('/api/version')),
  // PATCH /api/settings — write account preferences (partial body), the same
  // call web's `setPreferences` makes.
  setPreferences: (patch: Partial<AccountPreferences>) =>
    request<{ preferences: AccountPreferences }>('/api/settings', { method: 'PATCH', body: patch }),
  // GET /api/chats — `snoozed=include` because the phone DRAWS snoozed chats in
  // their own section (spec/15 § Chats tab) rather than hiding them. The default
  // response omits them entirely, which would leave the Snoozed section empty
  // until a live `chat.state` happened to arrive.
  listChats: () => request<{ chats: ChatListEntry[] }>('/api/chats?snoozed=include'),
  // GET /api/chats?archived=only — the Archived section's own list, fetched
  // when the section opens or a search starts (spec/15 ## Chats tab §7). The
  // cold-start roster above excludes archived chats, and they are unbounded.
  listArchivedChats: () => request<{ chats: ChatListEntry[] }>('/api/chats?archived=only'),
  // GET /api/chats?hidden=only — the Hidden section's own list (spec/04 §
  // Hidden), fetched when the section opens or a search starts. The cold-start
  // roster above leaves hidden chats out, exactly as it does archived ones.
  listHiddenChats: () => request<{ chats: ChatListEntry[] }>('/api/chats?hidden=only'),
  // Global chat search (spec/03 § Chat search): names and full transcript text
  // across every chat on every host. The caller trims and enforces
  // CHAT_SEARCH_MIN_QUERY first — the server answers a shorter query with 400.
  searchChats: (
    q: string,
    opts: { limit?: number; offset?: number; signal?: AbortSignal } = {},
  ) => {
    const params = new URLSearchParams({ q });
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    return request<ChatSearchResponse>(
      `/api/chats/search?${params.toString()}`,
      opts.signal === undefined ? {} : { signal: opts.signal },
    );
  },
  createChat: (body: {
    /** The host to run on. Required (spec/04 § Spawn). */
    hostId: string;
    folder: string;
    prompt?: string;
    name?: string;
    /** From the named host's catalogue; omitted takes that host's last-used. */
    model?: string;
    /** The chat's starting mode; omitted takes the shared default (spec/02). */
    permissionMode?: PermissionMode;
    /** The shared account the chat's turns start on (spec/10 — preferred account). */
    preferredAccountId?: string;
  }) =>
    request<{ chatId: string; folder: string; status: 'pending' }>('/api/chats', {
      method: 'POST',
      body,
    }),
  deleteChat: (chatId: string) =>
    request<{ ok: true }>(`/api/chats/${chatId}`, { method: 'DELETE' }),
  // spec/04 § Moving a chat to another host — resolves once the chat is running
  // there; every refusal is an ApiError whose body carries the reason.
  // `fromServerCopy` moves from the server's copy of an online host's chat;
  // an offline host is implied and needs no option.
  moveChat: (
    chatId: string,
    hostId: string,
    folder: string,
    options?: { fromServerCopy?: boolean },
  ) =>
    request<{ ok: true; chatId: string; hostId: string; folder: string }>(
      `/api/chats/${chatId}/move`,
      {
        method: 'POST',
        body: options?.fromServerCopy
          ? { hostId, folder, fromServerCopy: true }
          : { hostId, folder },
      },
    ),
  archiveChat: (chatId: string, archived: boolean) =>
    request<unknown>(`/api/chats/${chatId}/archive`, { method: 'POST', body: { archived } }),
  pinChat: (chatId: string, pinned: boolean) =>
    request<unknown>(`/api/chats/${chatId}/pin`, { method: 'POST', body: { pinned } }),
  // GET /api/chats/counts — bare lifecycle-section totals (spec/04 § Section
  // counts). The Archived and Hidden headers' numbers come from here, not from
  // the store: the phone never lists either at cold start, so a locally-derived
  // count would read `0` for a section that is full.
  chatSectionCounts: () =>
    request<{
      archived: number;
      snoozed: number;
      hidden: number;
      deleted: number;
      automations: number;
    }>('/api/chats/counts'),
  // This chat's patch_watch tasks, running and recently ended (spec/14 § Main
  // chat panel — Background task bar; background-task reliability overhaul
  // part 3). Real fields off the host's persisted watch record.
  watchList: (chatId: string) => request<{ tasks: WatchTaskRow[] }>(`/api/chats/${chatId}/watch`),
  // Kill a running task outright. Idempotent: killing an already-ended task
  // answers `stopped: false` rather than erroring.
  watchStop: (chatId: string, taskId: string) =>
    request<{ stopped: boolean }>(`/api/chats/${chatId}/watch/${encodeURIComponent(taskId)}/stop`, {
      method: 'POST',
    }),
  // POST /api/chats/:id/snooze — `snoozedUntil` is ABSOLUTE ms epoch, resolved
  // from a preset delta on this surface (spec/04 § Snooze); `null` unsnoozes.
  // The server rejects a past timestamp with 400 and that rejection is left to
  // surface: NO FALLBACK to a quietly-corrected "now".
  // `setId` names the user action (a project snooze sends one id for every
  // chat), so the host can clear the Back state of the whole set at once.
  snoozeChat: (chatId: string, snoozedUntil: number | null, setId?: string) =>
    request<unknown>(`/api/chats/${chatId}/snooze`, {
      method: 'POST',
      body: setId === undefined ? { snoozedUntil } : { snoozedUntil, setId },
    }),
  // POST /api/chats/:id/snooze/back-clear — the chat was opened; the host
  // clears the Back state of its whole set (spec/04 § Snooze → Back).
  clearSnoozeBack: (chatId: string) =>
    request<unknown>(`/api/chats/${chatId}/snooze/back-clear`, { method: 'POST' }),
  // spec/04 § Name — rename: a null clears the name back to the derived label.
  renameChat: (chatId: string, name: string | null) =>
    request<unknown>(`/api/chats/${chatId}/rename`, { method: 'POST', body: { name } }),
  // POST /api/chats/:id/hide — `hidden: false` is Show (spec/04 § Hidden): the
  // chat moves into the active list without anything being sent to it.
  hideChat: (chatId: string, hidden: boolean) =>
    request<unknown>(`/api/chats/${chatId}/hide`, { method: 'POST', body: { hidden } }),
  // spec/06 § Disabled — the special-thread "off" switch (same route as web).
  disableChat: (chatId: string, disabled: boolean) =>
    request<unknown>(`/api/chats/${chatId}/disable`, { method: 'POST', body: { disabled } }),
  // spec/06 § Session rotation — manual trigger for a reserved special thread
  // (same route as web): retire its Claude session and start fresh, seeded
  // with a handoff digest.
  rotateChat: (chatId: string) =>
    request<{ ok: true }>(`/api/chats/${chatId}/rotate`, { method: 'POST' }),
  // `/goal` — set (or clear, with null) the chat's goal (same route as web).
  setGoal: (chatId: string, goal: string | null) =>
    request<unknown>(`/api/chats/${chatId}/goal`, { method: 'POST', body: { goal } }),
  // spec/02 § Task list — replace the chat's task list with `todos` (the WHOLE list).
  setTodos: (chatId: string, todos: TodoItem[]) =>
    request<unknown>(`/api/chats/${chatId}/todos`, { method: 'POST', body: { todos } }),
  // `/loop` — arm (or, with null, cancel) the chat's recurring self-wake.
  // `every` is a duration string or seconds.
  setLoop: (
    chatId: string,
    loop: { message: string; every: string | number; notAfter?: string } | null,
  ) => request<unknown>(`/api/chats/${chatId}/loop`, { method: 'POST', body: { loop } }),
  // `/remind` — set (or clear, with null) the chat's reminder.
  setReminder: (chatId: string, reminder: string | null) =>
    request<unknown>(`/api/chats/${chatId}/reminder`, { method: 'POST', body: { reminder } }),
  // spec/15 § Side threads screen — pulls a side thread's own track (a side
  // branch's content is not broadcast live, spec/04 § Parallel branches).
  getChatHistory: (chatId: string, opts: { branchId: string }) =>
    request<{ events: Array<Record<string, unknown>>; nextFromSeq?: number }>(
      `/api/chats/${chatId}/history?branchId=${encodeURIComponent(opts.branchId)}`,
    ),
  // spec/15 § Chat detail — Delegate tool row: the pushed read-only
  // transcript screen. A subagent is never in the chat registry (spec/02 §
  // Native subagent dispatch), so this reads its history through the PARENT.
  getDelegateHistory: (parentId: string, delegateId: string) =>
    request<{ events: Array<Record<string, unknown>>; nextFromSeq?: number }>(
      `/api/chats/${parentId}/delegates/${delegateId}/history`,
    ),
  // POST /api/voice/token (spec/07, server voice/token.ts). Body is
  // `.strict {chatId, role, surfaceKind}` — the mobile surface is always
  // `mobile`. Sending only `{chatId}` 400s (the server requires role +
  // surfaceKind), which would mean a voice session NEVER opens. Returns the
  // raw `token` (echoed in the host audio-WSS session_start frame), the
  // `sessionId`, the relative `audioUrl` (`/audio/<sessionId>`), and expiry.
  voiceToken: (chatId: string, role: 'voice-note' | 'voice-call' | 'voice-device-conv') =>
    request<{ token: string; sessionId: string; audioUrl: string; expiresAt: number }>(
      '/api/voice/token',
      {
        method: 'POST',
        body: { chatId, role, surfaceKind: 'mobile' },
      },
    ),
  /**
   * Upload a finished voice-note clip to `POST /api/voice/note` (spec/07 §
   * End-to-end voice transport). The server verifies the surface credential,
   * hands the m4a to the host (the Whisper owner) over the host link, and
   * on success injects the transcript as the chat's next user turn as a
   * `chat.input` with `source: { kind: 'voice-app', surfaceKind: 'mobile' }`,
   * returning `{ ok: true, transcript }`. Any non-2xx throws (NO FALLBACK —
   * the note is never silently dropped; the caller surfaces the error).
   */
  voiceNote: async (chatId: string, fileUri: string): Promise<{ ok: true; transcript: string }> => {
    const cred = loadCredential();
    const headers = new Headers();
    if (cred) headers.set('authorization', `Bearer ${cred}`);
    const form = new FormData();
    form.append('chatId', chatId);
    // RN FormData accepts {uri,name,type} object — typed as any here.
    form.append('audio', {
      uri: fileUri,
      name: 'voice-note.m4a',
      type: 'audio/m4a',
    } as unknown as Blob);
    const res = await fetch(apiUrl('/api/voice/note'), {
      method: 'POST',
      headers,
      body: form as unknown as BodyInit,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      throw new ApiError(res.status, errorMessageFrom(parsed, res.status), parsed);
    }
    return parsed as { ok: true; transcript: string };
  },
  /**
   * Upload a dictated clip to `POST /api/voice/transcribe` (spec/07 § "Dictation
   * into the composer"). Same auth + host round-trip as `voiceNote`, but the
   * server does NOT inject any chat turn — it only transcribes. The caller
   * (Composer, via `lib/dictation.ts`) drops the returned text into its own
   * draft input. Any non-2xx throws (NO FALLBACK — a failed transcription is
   * never silently dropped).
   *
   * The clip is always a WAV built client-side from the native mic's PCM16
   * buffer (`lib/pcmWav.ts`) — the server's multipart parser auto-detects
   * `format: 'wav'` from the `.wav` extension / mimetype
   * (`packages/server/src/voice/note.ts`), so no server change was needed.
   */
  voiceTranscribe: async (fileUri: string): Promise<{ ok: true; transcript: string }> => {
    const cred = loadCredential();
    const headers = new Headers();
    if (cred) headers.set('authorization', `Bearer ${cred}`);
    const form = new FormData();
    // RN FormData accepts {uri,name,type} object — typed as any here.
    form.append('audio', {
      uri: fileUri,
      name: 'dictation.wav',
      type: 'audio/wav',
    } as unknown as Blob);
    const res = await fetch(apiUrl('/api/voice/transcribe'), {
      method: 'POST',
      headers,
      body: form as unknown as BodyInit,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      throw new ApiError(res.status, errorMessageFrom(parsed, res.status), parsed);
    }
    return parsed as { ok: true; transcript: string };
  },
  /**
   * spec/15 § Composer — upload one composer attachment (image or file) for a
   * chat to `POST /api/chats/:chatId/attachment`. Multipart, so it builds the
   * FormData itself (RN accepts a `{uri,name,type}` object as the file part, the
   * same shape voiceNote uses). The server stores the file, hands a copy to the
   * host (Claude reads it by path) and returns the ref + inline URL. Any
   * non-2xx throws (NO FALLBACK — the attachment is never silently dropped).
   */
  uploadAttachment: async (
    chatId: string,
    file: { uri: string; name: string; mimeType: string },
  ): Promise<{ ok: true; ref: UploadedAttachment }> => {
    const cred = loadCredential();
    const headers = new Headers();
    if (cred) headers.set('authorization', `Bearer ${cred}`);
    const form = new FormData();
    form.append('file', {
      uri: file.uri,
      name: file.name,
      type: file.mimeType,
    } as unknown as Blob);
    const res = await fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}/attachment`), {
      method: 'POST',
      headers,
      body: form as unknown as BodyInit,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      throw new ApiError(res.status, errorMessageFrom(parsed, res.status), parsed);
    }
    return parsed as { ok: true; ref: UploadedAttachment };
  },
  pushRegister: (token: string) =>
    request<unknown>('/api/auth/push/register', {
      method: 'POST',
      body: { token, platform: 'android-expo' },
    }),
  // Pairing: complete a QR-initiated pair using the nonce shown on an
  // already-linked surface. Server returns a fresh JWT for this device.
  pairComplete: (body: { nonce: string; devicePublicKey: string; clientType: 'surface-mobile' }) =>
    request<{ credential: string; accountId: string; surfaceId: string }>(
      '/api/auth/pair/complete',
      { method: 'POST', body },
    ),
  // Revoke a surface by id — another linked device, or this one when it
  // deactivates itself (spec/14 § This surface). Same call as web.
  revoke: (id: string) =>
    request<{ ok: true }>('/api/auth/revoke', { method: 'POST', body: { id } }),
  // spec/10 § Surface linking: a single-use surface-pairing nonce for the
  // "Link a device" QR another device scans.
  surfacePairStart: () =>
    request<{ nonce: string; expiresAt: number; uri?: string }>('/api/auth/pair/start', {
      method: 'POST',
    }),
  // spec/10 § Host registration: the single-use code a host installer redeems.
  hostPairStart: () =>
    request<{ nonce: string; expiresAt: number }>('/api/auth/daemon/pair/start', {
      method: 'POST',
    }),
  // What host builds the server has published (Add a host).
  hostManifest: () =>
    request<{ version: string; artifacts: { target: string }[] }>('/api/daemon/host-latest.json'),
  hostInstallCommand: (os: 'macos' | 'linux') =>
    request<{ os: string; version: string; targets: string[]; command: string }>(
      `/api/daemon/install-command?os=${encodeURIComponent(os)}`,
    ),
  // Editable secrets key-value store (spec/15 § Settings tab — Secrets). The
  // host owns the store (it injects them into chats); the server serves the
  // published mirror here and round-trips writes to the host. Editable from
  // any surface: add/set a value (PUT upsert) or delete (DELETE).
  listSecrets: () => request<{ secrets: Array<{ key: string; value: string }> }>('/api/secrets'),
  setSecret: (key: string, value: string) =>
    request<{ ok: true }>(`/api/secrets/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { value },
    }),
  deleteSecret: (key: string) =>
    request<{ ok: true }>(`/api/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  listJobs: () => request<{ jobs: unknown[] }>('/api/jobs'),
  getJob: (id: string) => request<unknown>(`/api/jobs/${id}`),
  // Create / update / delete jobs. Bodies are shaped by src/lib/jobEditor
  // (JobCreateBody / JobPatchBody from @patch/wire/jobs) — mirrors the web
  // editor's api.createJob / api.patchJob / api.deleteJob.
  createJob: (body: unknown) => request<unknown>('/api/jobs', { method: 'POST', body }),
  patchJob: (id: string, body: unknown) =>
    request<unknown>(`/api/jobs/${id}`, { method: 'PATCH', body }),
  deleteJob: (id: string) => request<unknown>(`/api/jobs/${id}`, { method: 'DELETE' }),
  enableJob: (id: string) => request<unknown>(`/api/jobs/${id}/enable`, { method: 'POST' }),
  disableJob: (id: string) => request<unknown>(`/api/jobs/${id}/disable`, { method: 'POST' }),
  // POST /api/jobs/:id/run (spec/08 ## Manual run) — fires the job's action
  // once, immediately, outside its normal trigger. Mirrors web's api.runJob.
  runJob: (id: string) =>
    request<{ status: 'sent' | 'buffered' | 'queued'; fireId: string }>(`/api/jobs/${id}/run`, {
      method: 'POST',
    }),
  // Host-owned folder list for cold-start (spec/04 § Folders). The host
  // publishes its registry over the WS (`folders.list` / `folders.updated`);
  // this serves the current list to a surface that connected before/without a
  // live socket. The new-chat + job-editor pickers read it via folderStore.
  /**
   * Every host's published registry, grouped by host (spec/04 § Folders). A
   * flat union would make two machines' identical paths indistinguishable.
   */
  folders: () =>
    request<{ hosts: Array<{ hostId: string; roots: string[]; recent: string[] }> }>(
      '/api/folders',
    ),
  // Folder BROWSER (spec/04 § Browsing): list a directory's child directories
  // (or, with no `dir`, the host's browsable roots). Confined to the host's
  // project roots server/host-side — a dir escaping them 404s (NO FALLBACK).
  browseFolders: (hostId: string, dir?: string) =>
    request<{
      hostId: string;
      dir: string | null;
      parent: string | null;
      entries: Array<{ name: string; path: string }>;
    }>(
      `/api/folders/browse?hostId=${encodeURIComponent(hostId)}${
        dir ? `&dir=${encodeURIComponent(dir)}` : ''
      }`,
    ),
  // Host files (spec/03 § Host files, spec/15 § Host files and terminal): a
  // machine's filesystem by ABSOLUTE path, with no chat in between. No `path`
  // lists the host user's home, and the answer says where that is.
  hostFilesList: (hostId: string, path?: string) =>
    request<{ path: string; parent: string | null; entries: HostFileEntry[] }>(
      `/api/hosts/${encodeURIComponent(hostId)}/files${
        path ? `?path=${encodeURIComponent(path)}` : ''
      }`,
    ),
  hostFileRead: (hostId: string, path: string) =>
    request<{ path: string; content: string; size: number; version: string }>(
      `/api/hosts/${encodeURIComponent(hostId)}/files/content?path=${encodeURIComponent(path)}`,
    ),
  // Saves only over the version it was opened at: a file changed on disk since
  // is a 409 `conflict`, and nothing is written.
  hostFileWrite: (hostId: string, body: { path: string; content: string; baseVersion: string }) =>
    request<{ path: string; size: number; version: string }>(
      `/api/hosts/${encodeURIComponent(hostId)}/files/content`,
      { method: 'PUT', body },
    ),
  // Chat folder files (spec/14 § File browser): the folder a chat is pinned to,
  // by path relative to it ('' lists the folder itself). Writing goes over the
  // socket (`file.write`), not here — the server has no HTTP write.
  chatFilesList: (chatId: string, path = '') =>
    request<{
      path: string;
      entries: Array<{ name: string; type: 'file' | 'dir'; dirty?: boolean }>;
    }>(`/api/chats/${encodeURIComponent(chatId)}/files?path=${encodeURIComponent(path)}`),
  chatFileRead: (chatId: string, path: string) =>
    request<{ path: string; content: string; size: number }>(
      `/api/chats/${encodeURIComponent(chatId)}/files?path=${encodeURIComponent(path)}&content=1`,
    ),
  // Document editor (spec/14 § Document editor): mode, suggestions, threads and
  // versions of one `.md`. Every change is one `docAction`, and the host's
  // answer is the updated view.
  getDoc: (chatId: string, path: string) =>
    request<DocView>(
      `/api/chats/${encodeURIComponent(chatId)}/doc?path=${encodeURIComponent(path)}`,
    ),
  docAction: (chatId: string, path: string, action: DocAction) =>
    request<DocView>(`/api/chats/${encodeURIComponent(chatId)}/doc/action`, {
      method: 'POST',
      body: { path, action },
    }),
  // Opening a `.docx` converts it to the `.md` the editor opens; `warnings`
  // names whatever the conversion could not carry over.
  convertDocx: (chatId: string, path: string) =>
    request<{ mdPath: string; warnings: string[]; reused: boolean }>(
      `/api/chats/${encodeURIComponent(chatId)}/doc/convert`,
      { method: 'POST', body: { path } },
    ),
  // The export's bytes as base64 (the phone writes them to a file), with the
  // name the host gave it and any images it could not embed.
  exportDoc: async (
    chatId: string,
    path: string,
    format: 'docx' | 'pdf' | 'md',
  ): Promise<{ base64: string; filename: string; warnings: string[] }> => {
    const headers = new Headers({ 'content-type': 'application/json' });
    const cred = loadCredential();
    if (cred) headers.set('authorization', `Bearer ${cred}`);
    const res = await fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}/doc/export`), {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, format }),
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A non-JSON body is reported as the text it is.
      }
      throw new ApiError(res.status, errorMessageFrom(parsed, res.status), parsed);
    }
    const exported = res.headers.get('x-patch-doc-path');
    if (exported === null) throw new Error('export: the host named no file');
    const warnings = JSON.parse(res.headers.get('x-patch-doc-warnings') ?? '[]') as string[];
    return {
      base64: bytesToBase64(new Uint8Array(await res.arrayBuffer())),
      filename: exported.split('/').pop() ?? exported,
      warnings,
    };
  },
  // spec/01 § Settings — every write below is committed on the server and
  // answered with the committed shared state; hosts get it from the snapshot.
  sharedSettings: () => request<SharedState>('/api/settings/shared'),
  setProviderKey: (keyId: ProviderKeyId, value: string) =>
    request<SharedState>(`/api/providers/keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT',
      body: { value },
    }),
  revokeProviderKey: (keyId: ProviderKeyId) =>
    request<SharedState>(`/api/providers/keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE',
    }),
  adoptProviderKey: (keyId: ProviderKeyId, hostId: string) =>
    request<SharedState>(`/api/providers/keys/${encodeURIComponent(keyId)}/adopt`, {
      method: 'POST',
      body: { hostId },
    }),
  addAccount: (
    backendId: SharedBackendId,
    body: { token?: string; apiKey?: string; label?: string },
  ) => request<SharedState>(`/api/accounts/${backendId}`, { method: 'POST', body }),
  updateAccount: (
    backendId: SharedBackendId,
    accountId: string,
    body: { token?: string; label?: string },
  ) =>
    request<SharedState>(`/api/accounts/${backendId}/${encodeURIComponent(accountId)}`, {
      method: 'PATCH',
      body,
    }),
  disconnectAccount: (backendId: SharedBackendId, accountId: string) =>
    request<SharedState>(`/api/accounts/${backendId}/${encodeURIComponent(accountId)}/disconnect`, {
      method: 'POST',
    }),
  removeAccount: (backendId: SharedBackendId, accountId: string) =>
    request<SharedState>(`/api/accounts/${backendId}/${encodeURIComponent(accountId)}`, {
      method: 'DELETE',
    }),
  orderAccounts: (backendId: SharedBackendId, accountIds: string[]) =>
    request<SharedState>(`/api/accounts/${backendId}/order`, {
      method: 'PUT',
      body: { accountIds },
    }),
  setAccountStrategy: (backendId: SharedBackendId, strategy: AccountStrategy) =>
    request<SharedState>(`/api/accounts/${backendId}/strategy`, {
      method: 'PUT',
      body: { strategy },
    }),
  adoptAccount: (backendId: SharedBackendId, hostId: string) =>
    request<SharedState>(`/api/accounts/${backendId}/adopt`, {
      method: 'POST',
      body: { hostId },
    }),
  adoptClaudeSettings: (hostId: string, target: 'shared' | 'darwin' | 'linux') =>
    request<SharedState>('/api/settings/claude/adopt', {
      method: 'POST',
      body: { hostId, target },
    }),
  // Remove a host from the account (Settings → Hosts → "Remove this host").
  // Revokes its credential so it cannot reconnect without pairing again. Every
  // connected surface (this one included) is also sent `host.removed
  // {hostId}` and should drop the host from its list; the answer carries the
  // remaining roster. 404 `unknown_host` for an id the account does not hold.
  removeHost: (hostId: string) =>
    request<{ ok: true; hosts: AuthOkHost[] }>(`/api/hosts/${encodeURIComponent(hostId)}`, {
      method: 'DELETE',
    }),
  // Skills available in a folder's `.claude/skills` (job-editor Skill picker
  // and its Edit link, the composer's `/` menu and skill chips). `paths`
  // names the absolute file each skill is defined in, keyed by name; absent
  // when the host doesn't report it, in which case nothing may link to a
  // skill's source (spec/01 § GET /api/skills). `descriptions`/`frontmatter`
  // are the same per-skill data web reads for its preview panel — optional so
  // an older host that answers without them still reads as "none" rather than
  // throwing (spec/15 § Skill autocomplete).
  // PER MACHINE, same as `models` below: skills are per-host, so the caller
  // must say which — omitting it let the request fall through to "whichever
  // host last attached" and come back missing a skill real on the caller's
  // actual host.
  skills: (folder: string, hostId: string) =>
    request<{
      skills: string[];
      paths?: Record<string, string>;
      descriptions?: Record<string, string>;
      frontmatter?: Record<string, Record<string, string>>;
    }>(`/api/skills?folder=${encodeURIComponent(folder)}&hostId=${encodeURIComponent(hostId)}`),
  // The models a chat can run on (job-editor Model picker, spec/15 § Job
  // editor). PER MACHINE (spec/02 § Model catalogue) — the endpoint rejects a
  // call naming no host — and live, never a constant: a hand-kept list here
  // would go stale the next time Anthropic ships a model.
  models: (hostId: string) =>
    request<{ models: Array<{ id: string; label: string }>; fetchedAt?: string }>(
      `/api/models?hostId=${encodeURIComponent(hostId)}`,
    ),
  // spec/15 § Batch view — one account-wide batch, held server-side (same
  // routes as web).
  getBatch: () => request<BatchResponse>('/api/batch'),
  startBatch: (checkIn: BatchCheckInChoice) =>
    request<BatchResponse>('/api/batch/start', { method: 'POST', body: { checkIn } }),
  removeBatchMember: (chatId: string) =>
    request<BatchResponse>(`/api/batch/members/${encodeURIComponent(chatId)}`, {
      method: 'DELETE',
    }),
  checkInBatchNow: () => request<BatchResponse>('/api/batch/check-in-now', { method: 'POST' }),
  markBatchOpened: (chatId: string) =>
    request<BatchResponse>('/api/batch/opened', { method: 'POST', body: { chatId } }),
};

/** spec/15 § Batch view — the check-in choice `Batch` offers. */
export type BatchCheckInChoice = { type: 'time'; minutes: 15 | 20 | 30 } | { type: 'all-done' };

export interface BatchRecord {
  id: string;
  startedAt: number;
  checkIn: BatchCheckInChoice;
  checkInAt: number;
  members: string[];
  checkedIn: boolean;
  openedMemberIds: string[];
}

export interface BatchResponse {
  batch: BatchRecord | null;
  carryover: string[];
}
