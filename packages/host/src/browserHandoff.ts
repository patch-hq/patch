// Agent browser hand-off (spec/02 § Browser — Hand-off). The agent asks the
// user to take over a tab to sign in, pass 2FA or approve an OAuth consent;
// the user sees the tab live in the chat, clicks and types into it, and taps
// Done, at which point `request()` resolves and the agent carries on.
//
// WHAT THE MODEL NEVER SEES: frames, the address with its query, and the
// user's input all travel host <-> surfaces as wire events, not tool results.
// While a hand-off is open every agent tool refuses the tab, and what
// `request()` returns is the outcome plus an address with no query or
// fragment — never the page, the title, the typed text or an authorization
// code. NO FALLBACK: a tab that vanishes, an unreachable OAuth listener or a
// timeout is reported as exactly that.

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type {
  BrowserHandoffInput,
  BrowserHandoffOutcome,
  BrowserViewInput,
  WireEvent,
} from '@patch/wire';
import type { BrowserManager, Screencast } from './browser.js';

/** The live-view input this host takes: `patch.browser_view.input` and `.drive` at any time. */
export const BROWSER_VIEW_INPUT_VERSION = 2;

/** Input that means the user is working the page, not just looking: it takes the tab over. */
function takesOver(input: BrowserViewInput): boolean {
  switch (input.kind) {
    case 'pointer':
      return input.action !== 'move';
    case 'scroll':
    case 'copy':
      return false;
    case 'key':
      return input.action !== 'up';
    default:
      return true;
  }
}

export interface HandoffResult {
  outcome: BrowserHandoffOutcome;
  /** Address without query or fragment; '' if the tab is gone. */
  url: string;
  /** Present when an OAuth callback was relayed: the waiting process's HTTP status. */
  callbackStatus?: number;
}

/** What a `share` returns at once: the view is open and the agent carries on. */
export interface ShareResult {
  shared: true;
  handoffId: string;
  /** Address without query or fragment. */
  url: string;
}

export interface BrowserHandoffOptions {
  browser: BrowserManager;
  emit: (event: WireEvent) => void;
  logger: Logger;
  /** How often a live view checks it is still wanted. Frames themselves are pushed as the page paints. */
  checkIntervalMs?: number;
  /** Fewest milliseconds between two frames of one tab. */
  minFrameMs?: number;
  /** A watch not renewed for this long stops streaming. */
  watchTtlMs?: number;
  /** How long the user has before the hand-off ends as `timeout`. */
  defaultTimeoutMs?: number;
  /** How often a waiting hand-off is announced again. */
  stateRepeatMs?: number;
  now?: () => number;
}

interface Active {
  handoffId: string;
  chatId: string;
  tabId: string;
  reason: string;
  shared: boolean;
  startedAt: number;
  lastStateAt: number;
  settle: (outcome: BrowserHandoffOutcome) => void;
}

interface Viewer {
  lastAsk: number;
  viewport?: { width: number; height: number; scale: number };
}

interface Stream {
  chatId: string;
  lastAsk: number;
  timer: NodeJS.Timeout | null;
  cast?: Screencast;
  /** Open views of this tab, by the id each view minted ('' for an older surface's one view). */
  viewers: Map<string, Viewer>;
  /** The sign-in form last announced during a hand-off ('' for none). */
  formId?: string;
}

interface InputQueue {
  chain: Promise<void>;
  /** The newest pointer move not yet sent; older ones are dropped, not replayed. */
  move?: BrowserHandoffInput | BrowserViewInput;
}

export class BrowserHandoff {
  private readonly active = new Map<string, Active>();
  private readonly streams = new Map<string, Stream>();
  private readonly inputs = new Map<string, InputQueue>();
  private readonly checkIntervalMs: number;
  private readonly minFrameMs: number;
  private readonly watchTtlMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly stateRepeatMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: BrowserHandoffOptions) {
    this.checkIntervalMs = opts.checkIntervalMs ?? 1_000;
    this.minFrameMs = opts.minFrameMs ?? 50;
    this.watchTtlMs = opts.watchTtlMs ?? 15_000;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10 * 60_000;
    this.stateRepeatMs = opts.stateRepeatMs ?? 3_000;
    this.now = opts.now ?? Date.now;
  }

  /** `patch_browser_handoff`. Resolves when the user finishes, declines, or the hand-off times out. */
  async request(args: {
    chatId: string;
    tabId: string;
    reason: string;
    callbackPort?: number;
    timeoutMs?: number;
  }): Promise<HandoffResult> {
    const { browser } = this.opts;
    const { chatId, tabId, reason } = args;
    browser.beginHandoff(tabId);
    let relay: Awaited<ReturnType<BrowserManager['relayLoopback']>> | undefined;
    try {
      if (args.callbackPort !== undefined) {
        relay = await browser.relayLoopback(tabId, args.callbackPort);
      }
    } catch (err) {
      browser.endHandoff(tabId);
      throw err;
    }

    const handoffId = randomUUID();
    const startedAt = this.now();
    let settle!: (o: BrowserHandoffOutcome) => void;
    const decided = new Promise<BrowserHandoffOutcome>((resolve) => {
      settle = resolve;
    });
    this.active.set(handoffId, {
      handoffId,
      chatId,
      tabId,
      reason,
      shared: false,
      startedAt,
      lastStateAt: startedAt,
      settle,
    });
    this.emitState({ chatId, handoffId, tabId, reason, startedAt, status: 'waiting' });
    this.touchStream(chatId, tabId);

    const timeoutMs = args.timeoutMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => settle('timeout'), timeoutMs);
    let callbackStatus: number | undefined;
    let outcome: BrowserHandoffOutcome;
    try {
      const racers: Promise<BrowserHandoffOutcome>[] = [decided];
      if (relay) {
        racers.push(
          relay.delivered.then(({ status }) => {
            callbackStatus = status;
            return 'callback' as const;
          }),
        );
      }
      outcome = await Promise.race(racers);
    } finally {
      clearTimeout(timer);
      this.active.delete(handoffId);
      this.inputs.delete(handoffId);
      await relay?.dispose();
      browser.endHandoff(tabId);
    }
    this.emitState({ chatId, handoffId, tabId, reason, startedAt, status: 'ended', outcome });
    return {
      outcome,
      url: browser.redactedUrl(tabId),
      ...(callbackStatus !== undefined ? { callbackStatus } : {}),
    };
  }

  /**
   * `patch_browser_handoff` with `share`: put the tab in front of the user for
   * review and return at once. Unlike a hand-off the agent keeps the tab (no
   * lock, no redaction: there is no secret in a page being reviewed), nothing
   * times out, and the user's feedback arrives as ordinary chat messages. It
   * ends when the user closes the view, the tab closes, or the host stops.
   */
  async share(args: { chatId: string; tabId: string; reason: string }): Promise<ShareResult> {
    const { browser } = this.opts;
    const { chatId, tabId, reason } = args;
    browser.requireTab(tabId);
    for (const h of this.active.values()) {
      if (h.chatId === chatId && h.tabId === tabId) {
        throw new Error(`tab ${tabId} is already open to the user`);
      }
    }
    const handoffId = randomUUID();
    const startedAt = this.now();
    let settle!: (o: BrowserHandoffOutcome) => void;
    const decided = new Promise<BrowserHandoffOutcome>((resolve) => {
      settle = resolve;
    });
    this.active.set(handoffId, {
      handoffId,
      chatId,
      tabId,
      reason,
      shared: true,
      startedAt,
      lastStateAt: startedAt,
      settle,
    });
    this.emitState({
      chatId,
      handoffId,
      tabId,
      reason,
      startedAt,
      status: 'waiting',
      shared: true,
    });
    this.touchStream(chatId, tabId);
    void decided.then((outcome) => {
      this.active.delete(handoffId);
      this.inputs.delete(handoffId);
      this.emitState({
        chatId,
        handoffId,
        tabId,
        reason,
        startedAt,
        status: 'ended',
        outcome,
        shared: true,
      });
    });
    return { shared: true, handoffId, url: browser.redactedUrl(tabId) };
  }

  /**
   * `patch.browser_view.watch`. Each open view renews its own watch; the tab is
   * laid out at the size of the most recently renewed large view, and goes
   * back to the agent's size when no large view is left.
   */
  watch(
    chatId: string,
    tabId: string | undefined,
    on: boolean,
    view: { viewerId?: string; viewport?: { width: number; height: number; scale: number } } = {},
  ): void {
    const id = tabId ?? this.opts.browser.latestTabOwnedBy(chatId);
    if (id === undefined) {
      if (on) this.opts.logger.info({ chatId }, 'browser view: chat has no open tab to watch');
      return;
    }
    const viewerId = view.viewerId ?? '';
    if (on) {
      const stream = this.touchStream(chatId, id);
      stream.viewers.set(viewerId, {
        lastAsk: this.now(),
        ...(view.viewport ? { viewport: view.viewport } : {}),
      });
      void this.applyViewers(id, stream);
      return;
    }
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.viewers.delete(viewerId);
    // An older surface's watch:false always meant "stop"; a view of its own only leaves.
    if (viewerId === '' || stream.viewers.size === 0) this.stopStream(id);
    else void this.applyViewers(id, stream);
  }

  /**
   * `patch.browser_view.input`: the user's input to a tab their chat owns, at
   * any time. Working the page (a press, a key, text, navigation) takes the
   * tab over, so the agent pauses; looking (moves, scrolls) does not. Same
   * one-at-a-time queue as a hand-off's input.
   */
  viewInput(chatId: string, tabId: string, input: BrowserViewInput): Promise<void> {
    const { browser } = this.opts;
    if (browser.ownerOf(tabId) !== chatId) {
      this.opts.logger.warn(
        { chatId, tabId },
        'browser view: input for a tab this chat does not own',
      );
      return Promise.resolve();
    }
    if (takesOver(input) && !browser.isHandedOff(tabId) && browser.driverOf(tabId) === 'agent') {
      browser.setDriver(tabId, 'user');
    }
    return this.enqueue(
      `tab:${tabId}`,
      input.kind === 'pointer' && input.action === 'move',
      input,
      async (next) => {
        const out = await browser.viewInput(tabId, next as BrowserViewInput);
        if (next.kind === 'copy') {
          this.opts.emit({ type: 'patch.browser_view.clipboard', chatId, tabId, text: out ?? '' });
        }
      },
      { chatId, tabId },
    );
  }

  /** `patch.browser_view.drive`: Take over / Hand back. A hand-off the agent asked for ends only by Done. */
  drive(chatId: string, tabId: string, driver: 'agent' | 'user'): void {
    const { browser } = this.opts;
    if (browser.ownerOf(tabId) !== chatId) {
      this.opts.logger.warn(
        { chatId, tabId },
        'browser view: drive for a tab this chat does not own',
      );
      return;
    }
    if (browser.isHandedOff(tabId)) return;
    browser.setDriver(tabId, driver);
  }

  /**
   * `patch.browser_handoff.input`: ignored unless it names the live hand-off
   * for that chat. Inputs run one at a time in the order they came, so a click
   * never overtakes the move before it; a burst of moves collapses to the newest.
   */
  input(chatId: string, handoffId: string, input: BrowserHandoffInput): Promise<void> {
    const h = this.active.get(handoffId);
    if (!h || h.chatId !== chatId) {
      this.opts.logger.warn({ chatId, handoffId }, 'browser hand-off: input for no live hand-off');
      return Promise.resolve();
    }
    return this.enqueue(
      handoffId,
      input.kind === 'pointer' && input.action === 'move',
      input,
      (next) => this.opts.browser.userInput(h.tabId, next as BrowserHandoffInput),
      { chatId, handoffId },
    );
  }

  /**
   * Inputs run one at a time in the order they came, so a click never
   * overtakes the move before it; a burst of moves collapses to the newest.
   */
  private enqueue<T extends BrowserHandoffInput | BrowserViewInput>(
    key: string,
    isMove: boolean,
    input: T,
    run: (input: T) => Promise<void>,
    logCtx: Record<string, string>,
  ): Promise<void> {
    let q = this.inputs.get(key);
    if (!q) {
      q = { chain: Promise.resolve() };
      this.inputs.set(key, q);
    }
    const queue = q;
    if (isMove) {
      const queued = queue.move !== undefined;
      queue.move = input;
      if (queued) return queue.chain;
    }
    queue.chain = queue.chain.then(async () => {
      const next = (isMove ? queue.move : input) as T | undefined;
      if (isMove) queue.move = undefined;
      if (!next) return;
      try {
        await run(next);
      } catch (err) {
        // The kind of input is safe to log; its content is not.
        this.opts.logger.warn({ err, ...logCtx, kind: next.kind }, 'browser view: input failed');
      }
    });
    return queue.chain;
  }

  /** `patch.browser_handoff.control`. */
  control(chatId: string, action: 'done' | 'cancel', handoffId: string): void {
    const h = this.active.get(handoffId);
    if (!h || h.chatId !== chatId) {
      this.opts.logger.warn(
        { chatId, handoffId, action },
        'browser hand-off: control for no live hand-off',
      );
      return;
    }
    h.settle(action === 'done' ? 'done' : 'cancelled');
  }

  dispose(): void {
    for (const tabId of [...this.streams.keys()]) this.stopStream(tabId);
    for (const h of this.active.values()) h.settle('cancelled');
  }

  private emitState(s: {
    chatId: string;
    handoffId: string;
    tabId: string;
    reason: string;
    startedAt: number;
    status: 'waiting' | 'ended';
    outcome?: BrowserHandoffOutcome;
    shared?: boolean;
  }): void {
    this.opts.emit({
      type: 'patch.browser_handoff.state',
      chatId: s.chatId,
      handoffId: s.handoffId,
      tabId: s.tabId,
      status: s.status,
      reason: s.reason,
      startedAt: s.startedAt,
      ...(s.outcome ? { outcome: s.outcome } : {}),
      ...(s.shared ? { shared: true } : {}),
    });
  }

  // ---- live view ----------------------------------------------------------

  private touchStream(chatId: string, tabId: string): Stream {
    const existing = this.streams.get(tabId);
    if (existing) {
      existing.lastAsk = this.now();
      existing.chatId = chatId;
      return existing;
    }
    const stream: Stream = { chatId, lastAsk: this.now(), timer: null, viewers: new Map() };
    this.streams.set(tabId, stream);
    void this.startCast(tabId, stream);
    this.schedule(tabId, stream);
    return stream;
  }

  private stopStream(tabId: string): void {
    const s = this.streams.get(tabId);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    this.streams.delete(tabId);
    this.inputs.delete(`tab:${tabId}`);
    void s.cast?.stop();
    const { browser } = this.opts;
    if (browser.ownerOf(tabId) === undefined) return;
    void browser.setViewerViewport(tabId, null).catch((err: unknown) => {
      this.opts.logger.warn({ err, tabId }, 'browser view: could not put the agent size back');
    });
    // Nobody is looking any more: a tab the user took over goes back to the agent.
    if (!browser.isHandedOff(tabId) && browser.driverOf(tabId) === 'user') {
      browser.setDriver(tabId, 'agent');
    }
  }

  /** Lay the tab out for the most recently renewed large view, or the agent's size if none. */
  private async applyViewers(tabId: string, stream: Stream): Promise<void> {
    let pick: Viewer | undefined;
    for (const v of stream.viewers.values()) {
      if (v.viewport && (!pick || v.lastAsk > pick.lastAsk)) pick = v;
    }
    const { browser } = this.opts;
    try {
      const before = JSON.stringify(browser.viewerOf(tabId) ?? null);
      await browser.setViewerViewport(tabId, pick?.viewport ?? null);
      const after = JSON.stringify(browser.viewerOf(tabId) ?? null);
      if (before !== after && this.streams.get(tabId) === stream) await stream.cast?.refresh();
    } catch (err) {
      this.opts.logger.warn({ err, tabId }, 'browser view: could not size the tab for its view');
    }
  }

  private async startCast(tabId: string, stream: Stream): Promise<void> {
    try {
      const cast = await this.opts.browser.screencast(
        tabId,
        (f) => {
          if (this.streams.get(tabId) !== stream) return;
          this.opts.emit({
            type: 'patch.browser_view.frame',
            chatId: stream.chatId,
            tabId,
            ...f,
            inputVersion: BROWSER_VIEW_INPUT_VERSION,
          });
        },
        // The page closed. A crashed tab comes back under the same id; a closed one does not.
        () => {
          if (this.streams.get(tabId) !== stream) return;
          stream.cast = undefined;
          void this.startCast(tabId, stream);
        },
        { minFrameMs: this.minFrameMs },
      );
      if (this.streams.get(tabId) !== stream) {
        await cast.stop();
        return;
      }
      stream.cast = cast;
      await this.applyViewers(tabId, stream);
    } catch (err) {
      // The tab is gone (or the browser stopped): the view ends, loudly for the hand-off.
      this.opts.logger.info({ err, tabId }, 'browser view: stream ended');
      if (this.streams.get(tabId) !== stream) return;
      this.stopStream(tabId);
      for (const h of this.active.values()) if (h.tabId === tabId) h.settle('tab_closed');
    }
  }

  private schedule(tabId: string, stream: Stream): void {
    stream.timer = setTimeout(() => this.check(tabId), this.checkIntervalMs);
    stream.timer.unref();
  }

  private check(tabId: string): void {
    const stream = this.streams.get(tabId);
    if (!stream) return;
    const handedOff =
      this.opts.browser.isHandedOff(tabId) ||
      [...this.active.values()].some((h) => h.tabId === tabId);
    const now = this.now();
    let lapsed = false;
    for (const [id, v] of stream.viewers) {
      if (now - v.lastAsk > this.watchTtlMs) {
        stream.viewers.delete(id);
        lapsed = true;
      }
    }
    if (!handedOff && now - stream.lastAsk > this.watchTtlMs) {
      this.stopStream(tabId);
      return;
    }
    if (lapsed) void this.applyViewers(tabId, stream);
    // Say again that the user is wanted, so a surface that opened the chat late hears it.
    for (const h of this.active.values()) {
      if (h.tabId !== tabId || now - h.lastStateAt < this.stateRepeatMs) continue;
      h.lastStateAt = now;
      this.emitState({ ...h, status: 'waiting', ...(h.shared ? { shared: true } : {}) });
    }
    const waiting = [...this.active.values()].find((h) => h.tabId === tabId && !h.shared);
    if (waiting) void this.announceForm(tabId, stream, waiting.chatId);
    this.schedule(tabId, stream);
  }

  /** During a hand-off, tell the surfaces about the page's sign-in form whenever it changes. */
  private async announceForm(tabId: string, stream: Stream, chatId: string): Promise<void> {
    let form;
    try {
      form = await this.opts.browser.detectForm(tabId);
    } catch (err) {
      this.opts.logger.info({ err, tabId }, 'browser hand-off: could not look for a sign-in form');
      return;
    }
    const formId = form?.formId ?? '';
    if (stream.formId === formId || this.streams.get(tabId) !== stream) return;
    stream.formId = formId;
    this.opts.emit({
      type: 'patch.browser_view.form',
      chatId,
      tabId,
      formId: formId || 'none',
      site: form?.site ?? '',
      fields: form?.fields ?? [],
    });
  }
}
