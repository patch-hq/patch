// React Native WebSocket client. Mirrors packages/web/src/api/ws.ts but
// uses RN's AppState API (no DOM `document.visibility`).
//
// Spec/05 line 71: surface emits `surface.heartbeat` every 10s while
// foregrounded. History is read only from the server (`chat.history_request`
// and the account feed, spec/03); a host is never asked. NO FALLBACK on auth —
// bad/missing JWT throws at hello-time.

import { useNotificationsStore } from '../stores/notificationsStore';
import { useViewPositionStore } from '../stores/viewPositionStore';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import {
  FEED_CATCH_UP_REQUEST_ID,
  FEED_LAST_SCREEN_REQUEST_ID,
  CLOSE_AUTH_FAILED,
  CLOSE_SERVER_RESTARTING,
  RESTART_RETRY_MS,
  RESTART_WINDOW_MS,
  decodeCompat,
  restartingVersion,
  type WireEvent,
} from '@patch/wire';
import { clearCredential, loadCredential, store as feedStore } from '../lib/credential';
import { useChatStore } from '../stores/chatStore';
import { heldChatIds, heldCursor, saveEvents, saveResolution } from '../lib/transcriptCache';
import { useFolderStore } from '../stores/folderStore';
import { useHostRefusalStore } from '../stores/hostRefusalStore';
import { useSettingsStore } from '../stores/settingsStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useSignInStore } from '../stores/signInStore';
import { useBrowserHandoffStore } from '../stores/browserHandoffStore';
import { useTerminalStore } from '../stores/terminalStore';
import { speakInterrupt } from '../lib/speakInterrupt';
import { useUiStore } from '../stores/uiStore';
import { deliveryTracker } from '../lib/deliveryTracker';
import { useComposerDraftStore } from '../lib/composerDraft';
import { useNewChatDraftStore } from '../stores/newChatDraftStore';
import { useComposerAttachmentStore } from '../stores/composerAttachmentStore';
import { permissionDeliveryTracker } from '../lib/permissionDeliveryTracker';
import { mobileBuildInfo } from '../lib/buildInfo';
import { refreshRoster } from '../lib/rosterRefresh';
import { wsUrl } from '../config';

/**
 * Say ONCE, per distinct thing, that we ignored something from a newer sender
 * (spec/03 § Forward compatibility). `chat.state` arrives constantly, so a line
 * per frame would bury the log; the durable record is `wireCompatStats()`,
 * which the diagnostics screen reports.
 */
const compatSeen = new Set<string>();
function noteFirstSight(what: string): void {
  if (compatSeen.has(what)) return;
  compatSeen.add(what);
  console.warn(`[patch] wire: ignoring unknown ${what} — this surface is behind the host`);
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
/**
 * Dead-link watchdog window. The server answers every `surface.heartbeat` with
 * a `surface.heartbeat_ack`; once one has been seen on a socket, NO inbound
 * frame for this long means the link is dead even though the socket still
 * reports OPEN (a server or host that went away without a close frame). 30s =
 * three missed heartbeat cycles, the same window the web client uses.
 */
export const HEARTBEAT_LIVENESS_TIMEOUT_MS = 30_000;
/**
 * A dial that has neither opened nor failed by now is abandoned and redialled.
 * A restarting server or proxy can accept the TCP connection and never finish
 * the upgrade, leaving the socket CONNECTING with no close ever coming — no
 * retry, so the app sits on its reconnecting treatment for ever.
 */
export const CONNECT_TIMEOUT_MS = 15_000;
/**
 * How long inbound store events are gathered before being committed together
 * (see `queueForStore`). One frame: long enough that a history burst —
 * 500+ events inside half a second on a busy chat — collapses into a couple of
 * dozen commits instead of 500+, short enough that a single live message still
 * lands within the same frame it arrived in.
 */
export const STORE_BATCH_MS = 16;
/**
 * How long the link must be down, with the app in the FOREGROUND, before the
 * amber banner says so (spec/12 § Surface connection state model). Android
 * drops the socket while the app is backgrounded, so every open used to flash
 * "Reconnecting…" for the second the reconnect took. A real outage outlasts
 * this; a resume reconnect does not. The true state is never delayed —
 * `connection` flips on the close itself, for diagnostics and controls.
 */
export const DISCONNECT_GRACE_MS = 3000;
/**
 * How long an outage must last, foreground, before it is called a lost server
 * rather than a reconnect (spec/12 § Server lost). The banner changes wording.
 */
export const SERVER_LOST_MS = 60_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export class PatchWs {
  private ws: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  /** Until when redials stay fast after a going-away notice (0 = not restarting). */
  private restartingUntil = 0;
  private reconnectTimer: TimerHandle | null = null;
  private connectTimer: TimerHandle | null = null;
  /** Epoch ms of the last inbound frame on the current socket (watchdog input). */
  private lastInboundAt = 0;
  /** True once the current socket has received a heartbeat ack (arms the watchdog). */
  private pongSupported = false;
  private heartbeatTimer: TimerHandle | null = null;
  /** Running while a foreground outage is inside its grace period. */
  private outageTimer: TimerHandle | null = null;
  /** Running while a visible outage heads for `SERVER_LOST_MS`. */
  private lostTimer: TimerHandle | null = null;
  private closed = false;
  private url: string;
  private appStateSub: NativeEventSubscription | null = null;
  private currentAppState: AppStateStatus = AppState.currentState;
  /** Store events received but not yet committed — see `queueForStore`. */
  private storeQueue: WireEvent[] = [];
  private storeFlushTimer: TimerHandle | null = null;
  /**
   * The cursor each chat's last history read was asked from, ON THIS SOCKET. Cleared
   * on every new connection, so a reconnect always re-asks while one connection
   * never asks the same question twice.
   */
  private readonly lastHistoryCursor = new Map<string, number>();
  /** True once this client has been greeted; later greetings are reconnects. */
  private greeted = false;
  /**
   * The chats the server was last told this phone follows, on this socket
   * (`feed.resume` / `feed.follow`, spec/03 § Account feed). `null` until the
   * feed has been resumed on the current connection.
   */
  private followed: Set<string> | null = null;
  /** Coalesces store changes into one `feed.follow` check. */
  private followTimer: TimerHandle | null = null;
  private storeUnsub: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  static default(): PatchWs {
    return new PatchWs(wsUrl());
  }

  connect(): void {
    // Already started (and not closed since): a second call would open a second
    // socket whose frames are applied twice, and lose the first app-state
    // listener so `close()` could never remove it.
    if (this.appStateSub !== null) return;
    this.closed = false;
    this.openOnce();
    this.appStateSub = AppState.addEventListener('change', this.handleAppState);
    // Opening or leaving a chat, and the list changing, change what this
    // phone follows; the server hears about it with `feed.follow`.
    this.storeUnsub = useChatStore.subscribe((now, prev) => {
      if (now.activeChatId !== prev.activeChatId || now.chats !== prev.chats)
        this.scheduleFollowSync();
    });
  }

  close(): void {
    this.closed = true;
    this.clearConnectTimer();
    this.storeUnsub?.();
    this.storeUnsub = null;
    if (this.followTimer !== null) {
      clearTimeout(this.followTimer);
      this.followTimer = null;
    }
    this.followed = null;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Commit anything still waiting on the batch timer — events that were
    // received are events the user must see, and the timer is about to be
    // cancelled.
    if (this.storeFlushTimer !== null) {
      clearTimeout(this.storeFlushTimer);
      this.storeFlushTimer = null;
    }
    this.flushStoreQueue();
    this.stopHeartbeat();
    this.clearOutage();
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.ws?.close();
    this.ws = null;
    usePresenceStore.getState().setConnection('offline');
    // The WS is the only channel that carries host presence — once it is
    // gone we no longer know the host's state (spec/12 § connection model).
    usePresenceStore.getState().setHost('unknown');
    // App teardown — drop all delivery timers so nothing leaks. (A transient
    // socket-level close does NOT reset; pending inputs survive for redelivery.)
    deliveryTracker.reset();
    permissionDeliveryTracker.reset();
  }

  send(event: WireEvent): void {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      throw new Error('PatchWs: not connected');
    }
    this.ws.send(JSON.stringify(event));
  }

  /**
   * Best-effort send: silently no-ops when the socket isn't open. Used for
   * subscribe/heartbeat frames where a dropped frame is re-sent on reconnect
   * (the account feed re-subscribes every held chat).
   */
  safeSend(event: WireEvent): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(event));
  }

  /**
   * The cursor to ask a chat's transcript from: the highest DURABLE seq this
   * surface has actually rendered, or -1 when it holds nothing.
   *
   * Derived here rather than passed in, so the screen opening a chat and the
   * connect handler catching it up always ask the same question — two callers
   * computing it differently is a second read of the same transcript on the
   * same connection, which the store folds for messages and permission cards
   * but not for tool calls.
   *
   * Optimistic outgoing echoes carry a negative placeholder seq until the
   * host persists them, so they never count toward the cursor. A roster row's
   * `lastSeq` is deliberately not consulted: a metadata-only row has one
   * without the transcript to match, and `fromSeq` is EXCLUSIVE, so asking from
   * it would skip history this surface has never seen.
   */
  private readonly historyAsks = new Map<
    string,
    { chatId: string; kind: 'last' | 'before' | 'after' }
  >();
  private historySeq = 0;

  /** Ask the server for a page of a chat (spec/03 § Chat history). */
  private askHistory(chatId: string, at: { after?: number; before?: number }): void {
    const requestId = `h${++this.historySeq}`;
    const kind = at.after !== undefined ? 'after' : at.before !== undefined ? 'before' : 'last';
    this.historyAsks.set(requestId, { chatId, kind });
    this.ws?.send(
      JSON.stringify({
        type: 'chat.history_request',
        requestId,
        chatId,
        ...at,
        limit: kind === 'after' ? 500 : HISTORY_PAGE,
      }),
    );
  }

  /** The page before the earliest entry shown, as the reader scrolls up. */
  loadEarlier(chatId: string): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const store = useChatStore.getState();
    if (store.historyLoadingEarlier[chatId] || store.historyMore[chatId] !== true) return;
    this.flushStoreQueue();
    const earliest = (store.timelines[chatId] ?? []).reduce(
      (min, e) => (e.seq >= 0 && e.seq < min ? e.seq : min),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(earliest)) return;
    store.setHistoryLoadingEarlier(chatId, true);
    this.askHistory(chatId, { before: earliest });
  }

  /**
   * The chats this phone follows: the chat on screen, the most recent on the
   * list, and every chat it holds a transcript of (spec/03 § Account feed,
   * spec/05 § Loading). Cheap — it reads no transcript — because it is
   * re-checked as the list changes.
   */
  private followIds(): Set<string> {
    const { chats, timelines, activeChatId } = useChatStore.getState();
    const ids = new Set<string>();
    if (activeChatId !== null) ids.add(activeChatId);
    const recent = Object.values(chats)
      .sort((a, b) => b.lastUpdated - a.lastUpdated)
      .slice(0, FEED_RECENT_CHATS);
    for (const row of recent) ids.add(row.chatId);
    const held = heldChatIds();
    for (const chatId of Object.keys(chats)) {
      if (held.has(chatId) || (timelines[chatId]?.length ?? 0) > 0) ids.add(chatId);
    }
    return ids;
  }

  /** The followed chats with the position held in each. */
  private followList(ids: Set<string>): Map<string, number> {
    this.flushStoreQueue();
    const { timelines } = useChatStore.getState();
    const follow = new Map<string, number>();
    for (const chatId of ids) {
      follow.set(
        chatId,
        (timelines[chatId]?.length ?? 0) > 0 ? this.replayCursor(chatId) : heldCursor(chatId),
      );
    }
    return follow;
  }

  /**
   * After every connect to a server that runs the feed: the last feed position
   * this phone holds, and the chats it follows with the position held in each.
   */
  private resumeFeed(): void {
    const ids = this.followIds();
    const follow = this.followList(ids);
    this.noteFollowedCursors(follow, new Set());
    this.followed = ids;
    const after = loadFeedPos();
    this.ws?.send(
      JSON.stringify({
        type: 'feed.resume',
        ...(after !== null ? { after } : {}),
        follow: [...follow].map(([chatId, a]) => ({ chatId, after: a })),
      }),
    );
  }

  /**
   * The server answers each newly followed chat, so opening one need not ask
   * again from the same cursor — except a chat held nothing of and not on
   * screen: its answer went to the offline copy, so opening it asks for its
   * last screen itself.
   */
  private noteFollowedCursors(follow: Map<string, number>, already: Set<string>): void {
    const { activeChatId } = useChatStore.getState();
    for (const [chatId, after] of follow) {
      if (already.has(chatId)) continue;
      if (after < 0 && chatId !== activeChatId) continue;
      this.lastHistoryCursor.set(chatId, after);
    }
  }

  private scheduleFollowSync(): void {
    if (this.followTimer !== null) return;
    this.followTimer = setTimeout(() => {
      this.followTimer = null;
      this.syncFollow();
    }, FOLLOW_SYNC_MS);
  }

  /**
   * Tell the server when the set of chats this phone follows has changed — a
   * chat opened, a new chat at the top of the list, one dropped off it — with
   * `feed.follow`, which replaces the set. Without it the server keeps the set
   * from connect time: a chat that became recent since gets no entries until
   * it is opened, and one that fell away keeps sending them.
   */
  syncFollow(): void {
    if (this.followed === null) return;
    if (!this.ws || this.ws.readyState !== 1) return;
    const ids = this.followIds();
    const followed = this.followed;
    if (ids.size === followed.size && [...ids].every((c) => followed.has(c))) return;
    const follow = this.followList(ids);
    this.noteFollowedCursors(follow, followed);
    this.followed = ids;
    this.ws.send(
      JSON.stringify({
        type: 'feed.follow',
        follow: [...follow].map(([chatId, after]) => ({ chatId, after })),
      }),
    );
  }

  private replayCursor(chatId: string): number {
    // Committed store state only — anything still inside the batch window has
    // to land first or the cursor is computed against a transcript missing
    // entries that have already arrived. See `queueForStore`.
    this.flushStoreQueue();
    const timeline = useChatStore.getState().timelines[chatId];
    if (timeline === undefined || timeline.length === 0) return -1;
    // Error rows are left out: a failed turn's error reaches every surface, so
    // it can be the only entry held for a chat never read, and counting it
    // would put the cursor past the whole unseen history.
    return timeline.reduce(
      (max, e) => (e.kind !== 'error' && e.seq >= 0 && e.seq > max ? e.seq : max),
      -1,
    );
  }

  /**
   * Ask the server for a chat's history from our cursor (spec/03 § Chat
   * history), at most once per cursor per CONNECTION. The request is also what
   * subscribes this surface to the chat's live detail events.
   *
   * Per connection, not for all time: a reconnect must still catch up from the
   * same cursor, because the earlier request may have died with the old socket
   * before one entry came back. A request made while the socket is shut isn't
   * recorded — it never went. `force` drops the guard: a cached track the
   * server disagrees with is cleared and asked for again from the same empty
   * cursor (spec/15 § Instant open).
   */
  requestHistory(chatId: string, opts?: { force?: boolean }): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (opts?.force === true) this.lastHistoryCursor.delete(chatId);
    const after = this.replayCursor(chatId);
    if (this.lastHistoryCursor.get(chatId) === after) return;
    this.lastHistoryCursor.set(chatId, after);
    this.askHistory(chatId, after >= 0 ? { after } : {});
    useChatStore.getState().setReplaying(chatId, true);
  }

  private handleAppState = (next: AppStateStatus): void => {
    const prev = this.currentAppState;
    this.currentAppState = next;
    if (next !== 'active' && prev === 'active') {
      // Nobody is looking, and Android is about to drop the socket anyway —
      // an outage only counts while the app is on screen. Clearing a banner
      // already up is safe: if the link is still down on return, a fresh
      // grace period brings it back.
      this.clearOutage();
    }
    if (this.closed) return;
    if (next === 'active' && prev !== 'active' && (!this.ws || this.ws.readyState > 1)) {
      // Back on screen with no socket — the backgrounded app lost it. Dial
      // now rather than sitting out whatever backoff step was pending (up to
      // 30s, which WOULD outlast the grace), and start the grace from here:
      // a resume reconnect that lands within it never shows the banner.
      this.armOutage();
      this.reconnectNow();
      return;
    }
    if (!this.ws || this.ws.readyState !== 1) return;
    if (next === 'active' && prev !== 'active') {
      // The socket may have survived the background as a zombie, or live
      // events may have been throttled: re-read the roster on every return.
      void refreshRoster();
      this.safeSend({ type: 'surface.foregrounded' });
      // Live events for the open chat may have been throttled or lost while
      // backgrounded with the socket still OPEN. The roster refresh does not
      // touch the transcript, so ask again from our cursor — forced, because
      // an unchanged cursor is exactly what the per-connection guard swallows.
      // A reply that never arrived would otherwise stay missing until reopen.
      const { activeChatId } = useChatStore.getState();
      if (activeChatId !== null) this.requestHistory(activeChatId, { force: true });
      this.startHeartbeat();
    } else if (next !== 'active' && prev === 'active') {
      this.safeSend({ type: 'surface.backgrounded' });
      this.stopHeartbeat();
    }
  };

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      this.safeSend({ type: 'surface.heartbeat' });
      this.checkLiveness();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Detect a socket that is OPEN in name only. Once the server has acked a
   * heartbeat it acks every one, so a long gap in all inbound traffic means the
   * link is dead: force a reconnect rather than sit "connected" and frozen.
   */
  private checkLiveness(): void {
    if (!this.pongSupported) return;
    if (!this.ws || this.ws.readyState !== 1) return;
    if (Date.now() - this.lastInboundAt <= HEARTBEAT_LIVENESS_TIMEOUT_MS) return;
    console.warn('[ws] no traffic from the server, reconnecting');
    this.reconnectNow();
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private openOnce(): void {
    const cred = loadCredential();
    if (!cred) {
      // Nothing to authenticate with, so there is nothing to connect to. This
      // THREW, with a comment saying the caller should redirect to pairing —
      // and no caller did: `bootstrap()` calls `connect()` fire-and-forget, so
      // the throw went nowhere, no socket was ever opened, and the app sat on
      // its connecting/reconnecting treatment for ever while the server never
      // heard from it. Nothing on the wire to diagnose, because nothing went
      // out. It is the same terminal state as a refusal — unauthenticated, go
      // and link the device — just arrived at without asking the server.
      this.endUnauthenticated('this device is not linked yet', { clear: false });
      return;
    }
    // Only show the neutral 'connecting' treatment on a FIRST connect. Once we
    // have been connected and dropped we are 'reconnecting'/'offline' (amber)
    // and must keep that treatment through the reconnect attempts, not flash
    // back to the quiet initial state.
    const cur = usePresenceStore.getState().connection;
    if (cur !== 'reconnecting' && cur !== 'offline') {
      usePresenceStore.getState().setConnection('connecting');
    }

    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.pongSupported = false;
    this.lastInboundAt = Date.now();
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.closed || this.ws !== ws || ws.readyState !== 0) return;
      console.warn('[ws] connect attempt timed out, redialling');
      this.reconnectNow();
    }, CONNECT_TIMEOUT_MS);

    // A new socket has heard nothing: every held chat may need its history
    // again, including one whose request died with the old connection.
    this.lastHistoryCursor.clear();
    // Nothing is followed on a new socket until `feed.resume` says so.
    this.followed = null;
    ws.onopen = (): void => {
      this.clearConnectTimer();
      this.lastInboundAt = Date.now();
      // The backoff is NOT reset here: an accepted upgrade proves nothing. A
      // server that takes the socket and then drops it (rate limit, overload, a
      // refused hello) would be redialled once a second for ever. It starts
      // over on the server's greeting, `auth.ok`.
      // Report what this phone is really running (native APK version + the JS
      // bundle actually executing) so the update panel can spot a phone left
      // behind — spec/11 § Version reporting.
      const build = mobileBuildInfo();
      const hello: WireEvent = {
        type: 'hello',
        clientType: 'surface-mobile',
        clientVersion: build.version,
        ...(build.gitSha ? { clientGitSha: build.gitSha } : {}),
        ...(build.builtAt ? { clientBuiltAt: build.builtAt } : {}),
        auth: cred,
      };
      ws.send(JSON.stringify(hello));
      usePresenceStore.getState().setConnection('connected');
      this.clearOutage();
      // Connection forensics for the diagnostics screen (spec/12 § Connection
      // diagnostics screen): a link that has come up at least once is never
      // treated as "this surface can't connect at all".
      usePresenceStore.getState().noteWsOpen(this.url);

      // Every chat this surface holds is caught up by the account feed, resumed
      // from `auth.ok` (spec/03 § Account feed): nothing is asked chat by chat.
    };

    ws.onmessage = (msg: { data: unknown }): void => {
      if (this.ws === ws) this.lastInboundAt = Date.now();
      const data = typeof msg.data === 'string' ? msg.data : '';
      let result: ReturnType<typeof decodeCompat>;
      try {
        // `decodeCompat`, not `decode`: a phone is the surface most likely to
        // be OLDER than the host — it was off, or offline, or simply has not
        // taken the OTA yet — and an additive field on `chat.state` must not
        // take the whole app down with a wall of banners (spec/03 § Forward
        // compatibility). A frame that is genuinely malformed still throws and
        // still gets a banner.
        result = decodeCompat(data);
      } catch (err) {
        useUiStore.getState().pushError(`malformed wire event: ${(err as Error).message}`);
        return;
      }
      if (!result.ok) {
        // An event type this build has never heard of: dropped, counted in
        // `wireCompatStats()`, reported by the diagnostics screen. One banner
        // per frame would bury the app.
        noteFirstSight(`type ${result.type}`);
        return;
      }
      for (const path of result.tolerated) noteFirstSight(`field ${path}`);
      if (result.event.type === 'surface.heartbeat_ack') {
        if (this.ws === ws) this.pongSupported = true;
        return;
      }
      this.dispatch(result.event);
    };

    ws.onclose = (ev?: { code?: number; reason?: string }): void => {
      // A socket already replaced (`reconnectNow` abandons the old one before
      // dialling) must not null out, or reschedule over, its successor.
      const current = this.ws === ws;
      if (current) this.clearConnectTimer();
      if (current) {
        this.ws = null;
        this.stopHeartbeat();
        useChatStore.getState().clearReplaying();
      }
      // Record WHY, before the early return — a close during teardown is still
      // the last thing that happened to this socket (spec/12 § Connection
      // diagnostics screen). A failed connect attempt fires 'close' too, which
      // is what makes `failedAttempts` meaningful on a surface that has never
      // reached OPEN.
      usePresenceStore.getState().noteWsClose({
        code: ev?.code ?? 0,
        reason: ev?.reason ?? '',
        at: Date.now(),
      });
      if (this.closed || !current) return;
      // No exit frame comes down a dead socket: end the shells here so none
      // keeps claiming to be live.
      useTerminalStore.getState().interrupt('Connection lost, reconnecting');
      // 4401 is the hub REFUSING this credential, not a link that dropped
      // (ws-hub CLOSE_AUTH_FAILED). Retrying cannot fix a refusal — it just
      // reports "reconnecting" for ever while the server has already said no,
      // leaving the user to diagnose it. End the session instead.
      if (ev?.code === CLOSE_AUTH_FAILED) {
        this.endUnauthenticated(
          ev.reason && ev.reason.length > 0 ? ev.reason : 'invalid credential',
        );
        return;
      }
      usePresenceStore.getState().setConnection('reconnecting');
      this.armOutage();
      // Host presence is no longer observable while the WS is down; drop
      // back to `unknown` so the daemon-offline banner does not linger on top
      // of the WS-reconnecting banner (the two states are distinct).
      usePresenceStore.getState().setHost('unknown');
      // The server said it is going away: dial at once rather than waiting out
      // a backoff, and show 'Restarting' live (not after the outage grace).
      if (ev?.code === CLOSE_SERVER_RESTARTING) {
        usePresenceStore
          .getState()
          .setRestarting({ version: restartingVersion(ev.reason), at: Date.now() });
        this.restartingUntil = Date.now() + RESTART_WINDOW_MS;
        try {
          this.openOnce();
        } catch (err) {
          useUiStore.getState().pushError(`ws reopen failed: ${(err as Error).message}`);
        }
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = (): void => {
      // 'close' will follow.
    };
  }

  /**
   * Dial immediately, abandoning the backoff wait (spec/12 § Connection
   * diagnostics screen — Retry now). Backoff resets to its first step so a
   * subsequent failure doesn't resume at the 30s ceiling.
   */
  reconnectNow(): void {
    if (this.closed) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoff = INITIAL_BACKOFF_MS;
    this.stopHeartbeat();
    const existing = this.ws;
    this.ws = null;
    try {
      existing?.close();
    } catch {
      // best-effort: closing an already-dead socket may throw; ignore.
    }
    try {
      this.openOnce();
    } catch (err) {
      // NO FALLBACK: a retry that cannot even open (no credential) says so.
      useUiStore.getState().pushError(`ws reopen failed: ${(err as Error).message}`);
    }
  }

  /**
   * The server refused this surface. TERMINAL: stop dialling, drop the dead
   * credential, and say what happened so the app can put the user back at
   * pairing with a reason rather than an unexplained sign-in screen.
   *
   * The credential goes because it can never work again — keeping it would
   * send the app straight back to the same refusal on the next launch, which
   * is the loop this exists to break. An EXPIRED session is a different thing
   * and is deliberately not routed here (spec/10 § Surface).
   */
  private endUnauthenticated(reason: string, opts: { clear?: boolean } = {}): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.clearOutage();
    try {
      this.ws?.close();
    } catch {
      // already gone
    }
    this.ws = null;
    // A REFUSED credential is dropped — keeping it would send the app straight
    // back into the same refusal next launch. A device that never had one has
    // nothing to drop, and saying "signed out" would be a lie.
    const clear = opts.clear !== false;
    if (clear) clearCredential();
    usePresenceStore.getState().setAuthRejected(reason);
    usePresenceStore.getState().setConnection('unauthenticated');
    usePresenceStore.getState().setHost('unknown');
    useUiStore
      .getState()
      .pushError(
        clear ? `Signed out: ${reason}. Link this device again.` : `Not connected: ${reason}.`,
      );
  }

  /**
   * Start the disconnect grace, if the app is on screen and it is not already
   * running or spent. When it expires with the link still down, the outage is
   * real and the banner shows. Backgrounded, nothing is armed: the resume
   * handler arms it afresh when the app comes back.
   */
  private armOutage(): void {
    if (this.closed || this.currentAppState !== 'active') return;
    if (this.outageTimer !== null || usePresenceStore.getState().outageVisible) return;
    this.outageTimer = setTimeout(() => {
      this.outageTimer = null;
      if (this.closed || this.currentAppState !== 'active') return;
      if (usePresenceStore.getState().connection === 'connected') return;
      usePresenceStore.getState().setOutageVisible(true);
      this.lostTimer = setTimeout(() => {
        this.lostTimer = null;
        if (this.closed || this.currentAppState !== 'active') return;
        if (usePresenceStore.getState().connection === 'connected') return;
        usePresenceStore.getState().setServerLost(true);
      }, SERVER_LOST_MS - DISCONNECT_GRACE_MS);
    }, DISCONNECT_GRACE_MS);
  }

  /** The link is back (or no longer being watched): cancel the grace, drop the banner. */
  private clearOutage(): void {
    if (this.outageTimer !== null) {
      clearTimeout(this.outageTimer);
      this.outageTimer = null;
    }
    if (this.lostTimer !== null) {
      clearTimeout(this.lostTimer);
      this.lostTimer = null;
    }
    usePresenceStore.getState().setOutageVisible(false);
    usePresenceStore.getState().setServerLost(false);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    let delay = this.backoff;
    if (this.restartingUntil > Date.now()) {
      delay = RESTART_RETRY_MS;
    } else {
      this.restartingUntil = 0;
      // The restart took longer than announced: it is an outage now, not a restart.
      usePresenceStore.getState().setRestarting(null);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      try {
        this.openOnce();
      } catch (err) {
        useUiStore.getState().pushError(`ws reopen failed: ${(err as Error).message}`);
      }
    }, delay);
  }

  private dispatch(event: WireEvent): void {
    // A refused ask (unknown chat, host error) will never be followed by a last
    // chunk, so the loading state ends here rather than sitting there forever.
    if (event.type === 'chat.error' && typeof event.chatId === 'string') {
      useChatStore.getState().setReplaying(event.chatId, false);
    }
    if (event.type === 'auth.ok') {
      this.backoff = INITIAL_BACKOFF_MS;
      this.restartingUntil = 0;
      usePresenceStore.getState().setIdentity(event.accountId, event.surfaceId);
      // The greeting carries EVERY registered host with its presence and the
      // server's cached reports, so the phone's Hosts list is complete from the
      // first frame — asleep hosts included.
      usePresenceStore.getState().setHosts(event.hosts);
      // spec/14 § Composer — push every draft the server never confirmed
      // (typed while offline, or a save that failed mid-flight) now that the
      // link is back.
      useComposerDraftStore.getState().resendPendingOnReconnect();
      // A RE-connect missed whatever the server fanned out while the socket
      // was down: the feed covers chats we hold a transcript for, so new,
      // renamed, deleted and re-ordered chats need the roster again. The
      // first greeting is covered by bootstrap's cold-start fetch.
      if (this.greeted) void refreshRoster();
      this.greeted = true;
      this.resumeFeed();
      // spec/12 § "Survives a server restart" — the server's surface→host
      // buffer is gone across a restart, so redeliver every still-pending input
      // now that the link is back (same localId; the host dedups). Same for
      // permission/question responses — see permissionDeliveryTracker.ts.
      deliveryTracker.onReconnect();
      permissionDeliveryTracker.onReconnect();
      if (this.currentAppState === 'active') this.startHeartbeat();
      return;
    }
    if (event.type === 'auth.revoked') {
      // The server is telling us the credential is dead, ahead of the close.
      // Same outcome, said sooner.
      this.endUnauthenticated(event.reason);
      return;
    }
    if (event.type === 'auth.expired') {
      // Transient — the credential simply aged out. Surface a non-destructive
      // notice; do NOT wipe the credential or force re-pairing.
      useUiStore.getState().pushError(`session expired: ${event.reason}`);
      return;
    }
    if (event.type === 'host.online') {
      usePresenceStore.getState().setHostOnline(event.hostId, true);
      // A terminal shell outlives a host restart: ask for each again by id.
      useTerminalStore.getState().hostBack(event.hostId);
      // The host is back — redeliver pending inputs so queued-while-offline
      // turns land promptly and any lost to a flush-time flap heals (idempotent;
      // the host dedups). spec/12.
      deliveryTracker.onReconnect();
      permissionDeliveryTracker.onReconnect();
      return;
    }
    if (event.type === 'host.offline') {
      usePresenceStore.getState().setHostOnline(event.hostId, false, event.reason);
      // Terminals are told nothing while the host is away: a PTY session's shell
      // outlives a restart (spec/02 § PTY sessions — Surviving a host restart).
      // The server reports them lost if the host does not return in time.
      return;
    }
    if (event.type === 'host.host') {
      usePresenceStore.getState().setHostReport(event);
      return;
    }
    if (event.type === 'host.unauthenticated') {
      // ONE backend's credential on ONE host is missing/expired (spec/10
      // § Backend credentials). NOT a presence fact: the host emitted this over
      // its own live link, so it stays online — a host that is up and simply
      // logged out of a backend must not be rendered as down.
      usePresenceStore.getState().setHostAccount({
        type: 'host.account',
        hostId: event.hostId,
        backendId: event.backendId,
        connected: false,
        accountEmail: null,
      });
      useUiStore.getState().pushError(`host unauthenticated: ${event.reason}`);
      return;
    }
    if (event.type === 'host.account') {
      // spec/10 § Surface in Settings — a backend's credential on a NAMED host
      // is switchable from ANY surface, so the phone tracks the same live state
      // the desktop does. Stored against the (host, backend) pair it names:
      // flattening it into an account-wide slot let one logged-out host make
      // every host look logged out.
      usePresenceStore.getState().setHostAccount(event);
      return;
    }
    if (event.type === 'folders.list' || event.type === 'folders.updated') {
      // spec/04 § Folders: each host publishes ITS OWN registry; keep that
      // host's picker group in sync. Both events carry that host's complete
      // roots + recents — replace that host's entry, leave the others alone.
      useFolderStore.getState().setHostFolders({
        hostId: event.hostId,
        roots: event.roots,
        recent: event.recent,
      });
      return;
    }
    if (event.type === 'host.removed') {
      // The host was removed from the account (by any surface): drop it and
      // its cached reports. A surface that missed this learns it from the next
      // `auth.ok`, whose roster no longer names the host.
      usePresenceStore.getState().removeHost(event.hostId);
      return;
    }
    if (event.type === 'claude_settings.list' || event.type === 'claude_settings.updated') {
      // spec/02 § Claude Code settings — that host's settings.json + memory
      // entries, sent whole on connect and after every edit, so Settings →
      // Hosts settles on what the host actually holds.
      usePresenceStore
        .getState()
        .setClaudeSettings(event.hostId, event.settingsJson, event.memories);
      return;
    }
    // spec/09 § bell — the agent-notification log changed; refetch.
    if (event.type === 'notifications.changed') {
      void useNotificationsStore.getState().load();
      return;
    }
    // spec/03 § Settings — the shared settings, in the greeting and after every change.
    if (event.type === 'settings.changed') {
      const state = {
        version: event.version,
        settings: event.settings,
        secrets: event.secrets,
        hosts: event.hosts,
      };
      useSettingsStore.getState().applyShared(state);
      return;
    }
    // spec/10 § Surface linking — a new device is asking to sign in.
    if (event.type === 'signin.requested') {
      useSignInStore
        .getState()
        .add({ id: event.id, label: event.label, expiresAt: event.expiresAt });
      return;
    }
    if (event.type === 'signin.resolved') {
      useSignInStore.getState().remove(event.id);
      return;
    }
    // spec/05 § Handover — where the user last was, on whichever surface.
    if (event.type === 'view_position.updated') {
      const { type: _type, ...pos } = event;
      useViewPositionStore.getState().applyUpdated(pos, usePresenceStore.getState().surfaceId);
      return;
    }
    // spec/14 § Composer — server-owned drafts. The cold-start snapshot, sent
    // once right after auth.ok, and the live per-chat updates that follow.
    if (event.type === 'composer_draft.list') {
      useComposerDraftStore.getState().applyDraftList(event.drafts);
      return;
    }
    if (event.type === 'composer_draft.attachments_list') {
      useComposerAttachmentStore.getState().applyList(
        event.drafts.map((d) => ({ draftKey: d.chatId, attachments: d.attachments })),
        'chat',
      );
      return;
    }
    if (event.type === 'composer_draft.updated') {
      useComposerDraftStore.getState().applyDraftUpdated(event.chatId, event.text, event.updatedAt);
      return;
    }
    if (event.type === 'composer_draft.cleared') {
      useComposerDraftStore.getState().applyDraftCleared(event.chatId, event.updatedAt);
      return;
    }
    // Step 3 of 3 (spec/14 & spec/15 § Composer → Attachments).
    if (event.type === 'composer_draft.attachments_changed') {
      useComposerAttachmentStore
        .getState()
        .applyAttachmentsChanged(event.chatId, event.attachments);
      return;
    }
    // spec/14 § New chat drafts — server-owned drafts. The cold-start
    // snapshot, sent once right after auth.ok, and the live updates that
    // follow.
    if (event.type === 'new_chat_draft.list') {
      useNewChatDraftStore.getState().applyDraftList(event.drafts);
      return;
    }
    if (event.type === 'new_chat_draft.attachments_list') {
      useComposerAttachmentStore.getState().applyList(
        event.drafts.map((d) => ({ draftKey: d.id, attachments: d.attachments })),
        'new-chat-draft',
      );
      return;
    }
    if (event.type === 'new_chat_draft.updated') {
      useNewChatDraftStore.getState().applyDraftUpdated({
        ...event.draft,
        updatedAt: event.updatedAt,
      });
      return;
    }
    if (event.type === 'new_chat_draft.removed') {
      useNewChatDraftStore.getState().applyDraftCleared(event.id, event.updatedAt);
      return;
    }
    if (event.type === 'new_chat_draft.attachments_changed') {
      useComposerAttachmentStore.getState().applyAttachmentsChanged(event.id, event.attachments);
      return;
    }
    if (
      event.type === 'patch.terminal.ready' ||
      event.type === 'patch.terminal.output' ||
      event.type === 'patch.terminal.exit' ||
      event.type === 'patch.terminal.error'
    ) {
      // spec/15 § Host files and terminal. Straight to the terminal's own
      // store, unbatched: a keystroke's echo is the one thing on this link a
      // person is watching for character by character.
      useTerminalStore.getState().ingest(event);
      return;
    }
    if (event.type === 'patch.browser_view.frame') {
      // spec/15 § Browser hand-off. Live-only, never a timeline entry.
      useBrowserHandoffStore.getState().applyFrame(event.chatId, event);
      return;
    }
    if (event.type === 'patch.browser_view.status') {
      useBrowserHandoffStore.getState().applyStatus(event);
      return;
    }
    if (event.type === 'patch.browser_handoff.state') {
      useBrowserHandoffStore.getState().applyState(event);
      return;
    }
    if (event.type === 'patch.browser_view.form') {
      useBrowserHandoffStore.getState().applyForm(event);
      return;
    }
    // spec/07 § A call can move between devices — a call live on another
    // surface is offered for switching here. This surface's own call is not.
    // The server's whole set of live calls (greeting, a host reconnecting or
    // going offline): replace the list, so a call whose end was missed goes.
    if (event.type === 'voice.calls') {
      const self = usePresenceStore.getState().surfaceId;
      useVoiceStore.getState().setRemoteCalls(event.calls.filter((c) => c.surfaceId !== self));
      return;
    }
    if (event.type === 'voice.call') {
      if (event.surfaceId === usePresenceStore.getState().surfaceId) return;
      const { type: _type, active, ...call } = event;
      useVoiceStore.getState().setRemoteCall(call, active);
      return;
    }
    if (event.type === 'chat.call_request') {
      useVoiceStore.getState().setIncoming({
        callId: event.callId,
        chatId: event.chatId,
        message: event.message,
        receivedAt: Date.now(),
      });
      return;
    }
    // spec/09 § Reaching the user — under `auto-notify` a call is spoken aloud
    // rather than ringing. Nothing is accepted and nothing is answered.
    if (event.type === 'chat.speak') {
      speakInterrupt(event.chatId, event.message);
      return;
    }
    if (event.type === 'chat.call_winner' || event.type === 'chat.call_timeout') {
      const incoming = useVoiceStore.getState().incomingCall;
      if (incoming && incoming.callId === event.callId) {
        useVoiceStore.getState().setIncoming(null);
      }
      return;
    }
    // spec/12 § Guaranteed input delivery — retire the pending mark on any event
    // that confirms an outgoing input was received (ack / queued / running /
    // reply / error). Runs for chat.input_ack too, which applyEvent ignores.
    // Stays SYNCHRONOUS: the tracker's timers are keyed to when the event
    // actually arrived, not to when the store next commits.
    if (event.type === 'chat.error' && event.chatId === 'pending-spawn') {
      // A host refusing a Settings edit (invalid settings.json, a memory it
      // does not hold) — addressed to no chat. Recorded for the editor that
      // sent it; still flows on to the store as before.
      useHostRefusalStore.getState().note(event.error.code, event.error.message);
    }
    deliveryTracker.observe(event);
    // Delivered, whatever the outcome — including a request the host
    // itself denied as expired. See permissionDeliveryTracker.ts.
    if (event.type === 'chat.permission_response') {
      permissionDeliveryTracker.ack(event.requestId);
    }
    // A history page is one frame carrying many entries (spec/03 § Chat
    // history). Unpack into the same queue the live path uses — same events,
    // same order, same reducer — and commit at once: there is nothing still to
    // come that it could coalesce with, and the transcript should paint once.
    if (event.type === 'chat.history') {
      const ask = this.historyAsks.get(event.requestId);
      this.historyAsks.delete(event.requestId);
      const store = useChatStore.getState();
      // A followed chat nobody has open goes to the offline copy; one on
      // screen, or already in the store, goes to the store as well.
      const shown =
        store.activeChatId === event.chatId || (store.timelines[event.chatId]?.length ?? 0) > 0;
      if (shown || ask !== undefined) {
        for (const inner of event.entries) this.dispatch(inner as WireEvent);
      } else {
        this.cacheOnly(event.entries as WireEvent[]);
      }
      for (const inner of event.pending) this.dispatch(inner as WireEvent);
      for (const inner of event.queued) this.dispatch(inner as WireEvent);
      this.flushStoreQueue();
      store.setReplaying(event.chatId, false);
      if (ask?.kind === 'before') {
        store.orderTimelineBySeq(event.chatId);
        store.setHistoryLoadingEarlier(event.chatId, false);
      }
      // `more` running backwards: older pages remain above what is held. A
      // followed chat this phone held nothing of comes as its last screen.
      if (
        ask?.kind === 'last' ||
        ask?.kind === 'before' ||
        event.requestId === FEED_LAST_SCREEN_REQUEST_ID
      )
        store.setHistoryMore(event.chatId, event.more);
      if (
        (ask?.kind === 'after' || event.requestId === FEED_CATCH_UP_REQUEST_ID) &&
        event.more &&
        shown
      ) {
        this.askHistory(event.chatId, { after: this.replayCursor(event.chatId) });
      }
      return;
    }
    if (event.type === 'feed.reset') {
      saveFeedPos(event.feedPos);
      void refreshRoster();
      return;
    }
    if (
      (event.type === 'chat.state' || event.type === 'chat.spawned') &&
      event.feedPos !== undefined
    ) {
      noteFeedPos(event.feedPos);
    }
    this.queueForStore(event);
  }

  /**
   * Hold a store event for up to one frame so a burst commits once.
   *
   * A history page delivers many entries at once — measured at 582
   * events in 444ms on a busy chat — and a commit per event meant a re-render
   * and a full-timeline regroup per event. Coalescing is what keeps opening a
   * long chat from locking the JS thread. Ordering is preserved: events are
   * committed in arrival order, and the store applies a batch as a single
   * sequential fold, so the result is identical to applying them one by one.
   */
  private queueForStore(event: WireEvent): void {
    this.storeQueue.push(event);
    if (this.storeFlushTimer !== null) return;
    this.storeFlushTimer = setTimeout(() => {
      this.storeFlushTimer = null;
      this.flushStoreQueue();
    }, STORE_BATCH_MS);
  }

  private cacheOnly(events: WireEvent[]): void {
    const byChat = new Map<string, unknown[]>();
    for (const e of events) {
      const chatId = (e as { chatId?: unknown }).chatId;
      if (typeof chatId !== 'string') continue;
      const list = byChat.get(chatId);
      if (list) list.push(e);
      else byChat.set(chatId, [e]);
    }
    for (const [chatId, list] of byChat) {
      saveEvents(chatId, list);
      useChatStore.getState().noteTranscriptHead(chatId, list);
    }
    for (const e of events) {
      if (e.type !== 'chat.permission_response' || e.chatId === undefined) continue;
      saveResolution(
        e.chatId,
        e.requestId,
        e.decision === 'deny' || e.approve === false ? 'deny' : 'approve',
        e.answers,
      );
    }
  }

  /** Commit everything gathered so far. Safe to call with an empty queue. */
  private flushStoreQueue(): void {
    if (this.storeQueue.length === 0) return;
    const batch = this.storeQueue;
    this.storeQueue = [];
    useChatStore.getState().applyEvents(batch);
    // Keep what was just drawn, so reopening this chat — or coming back after
    // Android has killed the app — paints from the phone instead of asking
    // the host for all of it again (spec/15 § Instant open). Only the durable
    // events are kept, and the write is coalesced; see transcriptCache.
    const byChat = new Map<string, unknown[]>();
    for (const event of batch) {
      const chatId = (event as { chatId?: unknown }).chatId;
      if (typeof chatId !== 'string') continue;
      const list = byChat.get(chatId);
      if (list) list.push(event);
      else byChat.set(chatId, [event]);
    }
    for (const [chatId, events] of byChat) saveEvents(chatId, events);
    // An answer carries no seq, so `saveEvents` skips it; the store's own
    // tap-to-answer path records its answers, this covers the host's echo of
    // one given elsewhere (spoken, or from another surface).
    for (const event of batch) {
      if (event.type !== 'chat.permission_response' || event.chatId === undefined) continue;
      saveResolution(
        event.chatId,
        event.requestId,
        event.decision === 'deny' || event.approve === false ? 'deny' : 'approve',
        event.answers,
      );
    }
  }
}

let _singleton: PatchWs | null = null;
export function getWs(): PatchWs {
  if (!_singleton) _singleton = PatchWs.default();
  return _singleton;
}
export function resetWs(): void {
  _singleton?.close();
  _singleton = null;
}

/** A page of history when opening a chat or scrolling up (spec/05 § Loading). */
const HISTORY_PAGE = 100;
/** How many of the most recently active chats the phone follows besides its offline copy. */
const FEED_RECENT_CHATS = 30;
/** How long store changes are gathered before checking whether the followed set changed. */
const FOLLOW_SYNC_MS = 300;
const FEED_POS_KEY = 'patch.feedPos';

function loadFeedPos(): number | null {
  const raw = feedStore().getString(FEED_POS_KEY);
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function saveFeedPos(pos: number): void {
  feedStore().set(FEED_POS_KEY, String(pos));
}

function noteFeedPos(pos: number): void {
  const held = loadFeedPos();
  if (held === null || pos > held) saveFeedPos(pos);
}
