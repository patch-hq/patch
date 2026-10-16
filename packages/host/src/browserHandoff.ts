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
import type { BrowserHandoffInput, BrowserHandoffOutcome, WireEvent } from '@patch/wire';
import type { BrowserManager } from './browser.js';

export interface HandoffResult {
  outcome: BrowserHandoffOutcome;
  /** Address without query or fragment; '' if the tab is gone. */
  url: string;
  /** Present when an OAuth callback was relayed: the waiting process's HTTP status. */
  callbackStatus?: number;
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
  startedAt: number;
  lastStateAt: number;
  settle: (outcome: BrowserHandoffOutcome) => void;
}

interface Stream {
  chatId: string;
  lastAsk: number;
  timer: NodeJS.Timeout | null;
  stopCast?: () => Promise<void>;
}

interface InputQueue {
  chain: Promise<void>;
  /** The newest pointer move not yet sent; older ones are dropped, not replayed. */
  move?: BrowserHandoffInput;
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

  /** `patch.browser_view.watch`. */
  watch(chatId: string, tabId: string | undefined, on: boolean): void {
    const id = tabId ?? this.opts.browser.latestTabOwnedBy(chatId);
    if (id === undefined) {
      if (on) this.opts.logger.info({ chatId }, 'browser view: chat has no open tab to watch');
      return;
    }
    if (on) this.touchStream(chatId, id);
    else this.stopStream(id);
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
    let q = this.inputs.get(handoffId);
    if (!q) {
      q = { chain: Promise.resolve() };
      this.inputs.set(handoffId, q);
    }
    const queue = q;
    const isMove = input.kind === 'pointer' && input.action === 'move';
    if (isMove) {
      const queued = queue.move !== undefined;
      queue.move = input;
      if (queued) return queue.chain;
    }
    queue.chain = queue.chain.then(async () => {
      const next = isMove ? queue.move : input;
      if (isMove) queue.move = undefined;
      if (!next) return;
      try {
        await this.opts.browser.userInput(h.tabId, next);
      } catch (err) {
        // The kind of input is safe to log; its content is not.
        this.opts.logger.warn(
          { err, chatId, handoffId, kind: next.kind },
          'browser hand-off: input failed',
        );
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
    });
  }

  // ---- live view ----------------------------------------------------------

  private touchStream(chatId: string, tabId: string): void {
    const existing = this.streams.get(tabId);
    if (existing) {
      existing.lastAsk = this.now();
      existing.chatId = chatId;
      return;
    }
    const stream: Stream = { chatId, lastAsk: this.now(), timer: null };
    this.streams.set(tabId, stream);
    void this.startCast(tabId, stream);
    this.schedule(tabId, stream);
  }

  private stopStream(tabId: string): void {
    const s = this.streams.get(tabId);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    this.streams.delete(tabId);
    void s.stopCast?.();
  }

  private async startCast(tabId: string, stream: Stream): Promise<void> {
    try {
      const stop = await this.opts.browser.screencast(
        tabId,
        (f) => {
          if (this.streams.get(tabId) !== stream) return;
          this.opts.emit({ type: 'patch.browser_view.frame', chatId: stream.chatId, tabId, ...f });
        },
        // The page closed. A crashed tab comes back under the same id; a closed one does not.
        () => {
          if (this.streams.get(tabId) !== stream) return;
          stream.stopCast = undefined;
          void this.startCast(tabId, stream);
        },
        { minFrameMs: this.minFrameMs },
      );
      if (this.streams.get(tabId) !== stream) {
        await stop();
        return;
      }
      stream.stopCast = stop;
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
    const handedOff = this.opts.browser.isHandedOff(tabId);
    if (!handedOff && this.now() - stream.lastAsk > this.watchTtlMs) {
      this.stopStream(tabId);
      return;
    }
    // Say again that the user is wanted, so a surface that opened the chat late hears it.
    for (const h of this.active.values()) {
      if (h.tabId !== tabId || this.now() - h.lastStateAt < this.stateRepeatMs) continue;
      h.lastStateAt = this.now();
      this.emitState({ ...h, status: 'waiting' });
    }
    this.schedule(tabId, stream);
  }
}
