// Agent browser (spec/02 § Browser, spec/06 § Browser tools). Step 1 of 3:
// the host component itself — a real, non-headless Chromium the agent can
// drive — and the ten patch_browser_* primitives. Live-view streaming and
// take-over (spec/14, spec/15) are a later step; this module owns no
// screencast and no per-chat "Browsing <site>" status.
//
// HONEST BY DESIGN: a normal Chrome/Chromium with a normal fingerprint, never
// headless (`headless: false`, under a real or virtual display), automation
// flags off (`navigator.webdriver` undefined, `--disable-blink-features=
// AutomationControlled`), real input events with human timing. No stealth
// beyond being a normal browser, no captcha-solving. NO FALLBACK: a host
// missing Chromium or (on Linux) Xvfb gets a clear `BrowserNotInstalledError`
// naming the fix, never a silent switch to headless or another engine.
//
// PROFILES: 'logged-in' (default) is ONE persistent userDataDir shared by
// every chat on this host, so a site logged into once stays logged in across
// chats and restarts. 'logged-out' is a throwaway in-memory context — no
// userDataDir, nothing written to disk, so it leaves no cookies behind.

import { createHash, randomUUID } from 'node:crypto';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Download,
  FileChooser,
  Frame,
  Locator,
  Page,
  Response,
} from 'playwright';
import type { Logger } from 'pino';
import type { WebBotAuthConfig } from './webBotAuth.js';
import {
  PATCH_WEBDRIVER_INIT_SCRIPT,
  STRUCTURED_SCRIPT,
  snapshotScript,
  textScript,
} from './browserScripts.js';

export class BrowserNotInstalledError extends Error {
  readonly code = 'browser_not_installed' as const;
  constructor(detail: string) {
    super(
      `browser component not installed on this host: ${detail} No fallback to another browser.`,
    );
    this.name = 'BrowserNotInstalledError';
  }
}

/**
 * spec/02 § Browser — In the Patch app. The app is installed here, so the
 * agent's browser lives in it, and it could not be reached. NO FALLBACK: never
 * a quiet switch to a separate Chromium.
 */
export class AppBrowserUnavailableError extends Error {
  readonly code = 'app_browser_unavailable' as const;
  constructor(detail: string) {
    super(`the agent's browser is in the Patch app on this machine, and ${detail}`);
    this.name = 'AppBrowserUnavailableError';
  }
}

export class TabNotFoundError extends Error {
  readonly code = 'tab_not_found' as const;
  constructor(tabId: string) {
    super(`browser tab not found (closed, or never opened): ${tabId}`);
    this.name = 'TabNotFoundError';
  }
}

export class TabInHandoffError extends Error {
  readonly code = 'tab_in_handoff';
  constructor(tabId: string) {
    super(
      `tab ${tabId} is in the user's hands (a hand-off is open); wait for patch_browser_handoff to return before acting on it`,
    );
    this.name = 'TabInHandoffError';
  }
}

/**
 * The user pressed Take over (or simply started using the tab) and has not
 * handed it back in time. NO FALLBACK: the agent is told, never left waiting
 * without end or let loose on a page the user is working.
 */
export class UserDrivingError extends Error {
  readonly code = 'user_driving' as const;
  constructor(tabId: string) {
    super(
      `the user has taken tab ${tabId} over and has not handed it back yet; carry on with something else or ask them, and use the tab once they hand it back`,
    );
    this.name = 'UserDrivingError';
  }
}

/**
 * A call that waited while the user drove the tab: it is not carried out on
 * a page the user may have changed underneath it.
 */
export class UserHandedBackError extends Error {
  readonly code = 'user_was_driving' as const;
  constructor(tabId: string, url: string) {
    super(
      `the user used tab ${tabId} and has handed it back, now at ${url}; read the page again before acting, it may have changed`,
    );
    this.name = 'UserHandedBackError';
  }
}

export class RefNotFoundError extends Error {
  readonly code = 'ref_not_found' as const;
  constructor(ref: string) {
    super(
      `element ref "${ref}" not found on the page — call patch_browser_read again, the page may have changed`,
    );
    this.name = 'RefNotFoundError';
  }
}

/**
 * spec/02 § Browser — Route through. NO FALLBACK: a routing host that is
 * offline fails the open outright, naming the host, rather than silently
 * going direct — that would make routing look like it is on when it is not.
 */
export class RoutingHostOfflineError extends Error {
  readonly code = 'routing_host_offline' as const;
  constructor(hostName: string) {
    super(
      `can't open the browser: the routing host "${hostName}" is offline, and browsing never falls back to going direct. Turn off "Route through" to browse from this host instead, or wait for "${hostName}" to come back online.`,
    );
    this.name = 'RoutingHostOfflineError';
  }
}

/**
 * Thrown to an agent's in-flight (or racing) browser call when the user pressed
 * "Stop" in Settings → Computer use. NO FALLBACK: the call fails and says why,
 * so the agent doesn't retry blindly or carry on as if the click had landed.
 */
export class BrowserStoppedError extends Error {
  readonly code = 'browser_stopped' as const;
  constructor() {
    super(
      'the user pressed Stop in Settings → Computer use: your browser windows were closed and this action was cancelled. Do not reopen the browser or retry unless the user asks you to.',
    );
    this.name = 'BrowserStoppedError';
  }
}

/** What Settings → Computer use shows for one host. */
export interface ComputerUseStatus {
  /** True while an action that moves the pointer or types is running. */
  active: boolean;
  /** Plain-language label of the running action ("Clicking"), when active. */
  action?: string;
  /** When the current run of activity began (ms epoch), when active. */
  since?: number;
  /** Browser windows (tabs) currently open. */
  tabs: number;
  /** When the user last pressed Stop (ms epoch), if this process ever saw it. */
  lastStoppedAt?: number;
}

export type PointerAction = 'click' | 'double_click' | 'right_click' | 'move' | 'drag' | 'scroll';

export interface PointerRequest {
  action: PointerAction;
  /** Viewport pixels, the same space `patch_browser_screenshot` is drawn in. */
  x?: number;
  y?: number;
  /** `drag` destination. */
  toX?: number;
  toY?: number;
  /** `scroll` wheel deltas in pixels (positive = down / right). */
  scrollX?: number;
  scrollY?: number;
}

export type BrowserProfile = 'logged-in' | 'logged-out';

export interface SnapshotNode {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  value?: string;
  checked?: boolean;
  options?: string[];
  href?: string;
  disabled?: boolean;
  /** Present for an element inside an iframe: that frame's address. */
  frame?: string;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  url?: string;
  at: number;
}

export interface NetworkEntry {
  id: number;
  method: string;
  url: string;
  resourceType: string;
  startedAt: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  failure?: string;
  ms?: number;
}

export interface DialogEntry {
  type: string;
  message: string;
  defaultValue?: string;
  handled: 'accepted' | 'dismissed';
  /** True when the tab's standing policy answered, not an armed patch_browser_dialog. */
  auto: boolean;
  at: number;
}

export interface DownloadEntry {
  tabId: string;
  filename: string;
  url: string;
  state: 'saving' | 'done' | 'failed';
  /** Absolute path on THIS host once `state` is 'done'. */
  path?: string;
  bytes?: number;
  error?: string;
  at: number;
}

/** Names an element: a ref from `read`, or a selector for what has none. */
export interface ElementTarget {
  ref?: string;
  selector?: string;
}

export interface StructuredContent {
  headings: Array<{ level: number; text: string }>;
  article: string;
  tables: Array<{ caption: string; headers: string[]; rows: string[][] }>;
  lists: Array<{ kind: string; items: string[] }>;
  links: Array<{ text: string; href: string }>;
}

export interface ReadResult {
  title: string;
  url: string;
  mode: 'snapshot' | 'text' | 'structured' | 'accessibility';
  snapshot?: SnapshotNode[];
  text?: string;
  structured?: StructuredContent;
  accessibility?: string;
  truncated?: boolean;
  /** A file chooser is open and waiting: patch_browser_upload (without a ref) fills it. */
  fileChooserOpen?: boolean;
  /** What happened to this tab behind the agent's back (a crash and recovery), told once. */
  notices?: string[];
}

export interface StorageState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export interface OpenResult {
  tabId: string;
  title: string;
  url: string;
  /** The routing host's display name, present iff this tab's traffic goes via one. */
  routedVia?: string;
  /**
   * True iff the page had not finished loading when the navigation timed out
   * (typically a bot check that never completes). The tab is kept and open:
   * the user can take it over with patch_browser_handoff and click through.
   */
  loading?: true;
}

export interface TabInfo {
  tabId: string;
  title: string;
  url: string;
  profile: BrowserProfile;
  /** The tab that opened this one (a target=_blank link, window.open). */
  openerTabId?: string;
  /** True for the tab the browser last brought to the front. */
  active?: boolean;
  /** The routing host's display name, present iff this tab's traffic goes via one. */
  routedVia?: string;
}

/** What survives a host restart of an open logged-in tab. */
interface PersistedTab {
  url: string;
  ownerChatId?: string | undefined;
}

interface Tab {
  tabId: string;
  page: Page;
  profile: BrowserProfile;
  /** Set only for a 'logged-out' tab: its own throwaway context, closed with it. */
  ephemeralContext?: BrowserContext;
  /** The chat that opened this tab, for a future "Browsing <site>" status row. */
  ownerChatId?: string;
  /** spec/02 § Browser — Route through: the routing host's display name, this tab's whole life. */
  routedVia?: string;
  routeThrough?: RouteThrough;
  openerTabId?: string;
  /** Last top-level address, what a recovery reloads. */
  lastUrl: string;
  crashed: boolean;
  /** The browser/context this tab lived in is gone (crash, kill, closed window). */
  contextDead: boolean;
  recovering?: Promise<void>;
  /** Told to the agent once, on its next read: what happened to this tab behind its back. */
  notices: string[];
  consoleLog: ConsoleEntry[];
  network: NetworkEntry[];
  responses: Map<number, Response>;
  requestIds: WeakMap<object, number>;
  dialogs: DialogEntry[];
  /** One-shot answer for the next confirm/prompt, armed by patch_browser_dialog. */
  armedDialog?: { accept: boolean; promptText?: string };
  fileChooser?: FileChooser;
  /** Held open for the tab's life: device emulation lives and dies with its CDP session. */
  cdp?: CDPSession;
  /** When the agent opened it (ms epoch): the live view's timer. */
  openedAt: number;
  /** In the Patch app: the tab's DevTools target there, so a large view can show it as itself. */
  appTarget?: string;
  /** Who is using it: the agent, or the user after Take over. */
  driver: 'agent' | 'user';
  /** Agent calls waiting for the user to hand the tab back. */
  driverWaiters: ((outcome: 'handed_back' | 'closed') => void)[];
  /** Where the agent last pointed, in viewport CSS pixels. */
  cursor?: { x: number; y: number; at: number };
  /** The agent emulated a named device: a viewer's size never overrides it. */
  agentDevice?: boolean;
  /** The agent set its own size while a view was open: views stop resizing the tab until all close. */
  viewerYielded?: boolean;
  /**
   * A large live view's size, which the tab takes while the view is open (the
   * agent then sees the same size), and its pixel ratio, laid on top through
   * `cdp` only. `saved` is the agent's size to put back.
   */
  viewer?: {
    width: number;
    height: number;
    scale: number;
    saved: { width: number; height: number };
  };
  frameNumbers: WeakMap<Frame, number>;
  nextFrameNumber: number;
}

/**
 * What `open()` was asked to route through, resolved by the CALLER (the
 * host knows which hosts are online and what they're called; this module
 * stays ignorant of hosts, the server, and the wire — same discipline as
 * every other BrowserManager option). `online: false` is a deliberate
 * input, not an edge case to guess at: the caller already knows the routing
 * host is down, and `open()` must refuse rather than silently going direct.
 */
export interface RouteThrough {
  hostId: string;
  hostName: string;
  online: boolean;
  /** `socks5://127.0.0.1:<port>` — the caller's already-running tunnel listener for this host. Required iff `online`. */
  proxyServer?: string;
}

export interface BrowserManagerOptions {
  /** `<patchHome>/browser` — the persistent 'logged-in' profile lives under here. */
  root: string;
  logger: Logger;
  /** Injectable for tests: swap the real `playwright` module for a fake one. */
  loadPlaywright?: () => Promise<typeof import('playwright')>;
  /**
   * The virtual display this manager's own Xvfb opens, when the host has
   * none already. Defaults to `:95` — fine for production (one host, one
   * BrowserManager); tests give each manager instance its own so two can run
   * without racing over the same X socket.
   */
  virtualDisplay?: string;
  /**
   * Web Bot Auth: when set, every http(s) request either profile makes is signed
   * (RFC 9421, tag `web-bot-auth`) so sites that verify agents can recognise
   * Patch. Tests may leave it unset; production also sets `webBotAuthRequired`.
   */
  webBotAuth?: WebBotAuthConfig;
  /** Called when a chat's browser activity changes (an action starts or ends, a tab opens or closes). */
  onActivity?: (chatId: string) => void;
  /**
   * spec/02 § Browser — In the Patch app: the Patch app on this machine hosts
   * the browser. Both profiles are its: the signed-in one is the app's own, a
   * throwaway one is an in-memory context there. No Chromium or Xvfb of this
   * host's own is started.
   */
  appBrowser?: AppBrowserLink;
}

/** Where the Patch app's browser is, starting the app when it is not running. */
export interface AppBrowserLink {
  /** Whether the app has ever run on this machine (its endpoint file exists). */
  present(): boolean;
  endpoint(): Promise<string>;
}

/** What a chat's surfaces show: is the agent driving a browser for it, and on which tabs. */
export interface ChatBrowserStatus {
  chatId: string;
  active: boolean;
  action?: string;
  since?: number;
  tabs: Array<{
    tabId: string;
    url: string;
    title: string;
    handedOff: boolean;
    driver: 'agent' | 'user';
    cursor?: { x: number; y: number; at: number };
    appTarget?: string;
    openedAt: number;
  }>;
  /** When the oldest of these tabs was opened. */
  openedAt?: number;
  lastStoppedAt?: number;
}

/** An address with no query or fragment: those carry authorization codes and tokens. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? `${u.protocol}${u.pathname}` : `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

export type HandoffUserInput =
  | {
      kind: 'pointer';
      action: 'click' | 'double_click' | 'right_click' | 'move';
      x: number;
      y: number;
    }
  | { kind: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string };

/** The live view's input (the wire's `BrowserViewInput`), as this module takes it. */
export type ViewUserInput =
  | {
      kind: 'pointer';
      action: 'move' | 'down' | 'up' | 'click' | 'double_click' | 'right_click';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[];
    }
  | { kind: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string; action?: 'press' | 'down' | 'up' }
  | { kind: 'nav'; action: 'back' | 'forward' | 'reload' | 'goto'; url?: string }
  | { kind: 'copy' }
  | { kind: 'fill'; formId: string; values: { field: string; value: string }[]; submit: boolean };

/** A sign-in form on the page, as a surface's own card shows it. Labels, never values. */
export interface DetectedForm {
  formId: string;
  site: string;
  fields: { field: string; label: string; kind: 'text' | 'email' | 'password' | 'code' }[];
}

/** One picture of a tab for the live view. */
export interface ScreencastFrame {
  data: string;
  /** Viewport, CSS pixels: the coordinate space of the user's input. */
  width: number;
  height: number;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface Screencast {
  stop(): Promise<void>;
  /** Send a picture now, as after the view's size changed on a page that is not moving. */
  refresh(): Promise<void>;
}

/**
 * What the user typed into the address bar, as an address: a URL as it is, a
 * bare domain over https, anything else a web search. `javascript:` is a
 * search, as it is in Chrome's own address bar.
 */
export function addressToUrl(text: string): string {
  const t = text.trim();
  if (/^(https?|file|about|data|chrome):/i.test(t)) return t;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(t) || /^127\.0\.0\.1(:\d+)?(\/.*)?$/.test(t)) {
    return `http://${t}`;
  }
  if (!/\s/.test(t) && /^[^\s/:]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

/**
 * Finds a sign-in form's visible fields, tags each with `data-patch-field` so
 * a fill can reach it, and returns their labels. Nothing about values.
 */
const DETECT_FORM_SCRIPT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled && !el.readOnly;
  };
  const kindOf = (el) => {
    const t = (el.type || 'text').toLowerCase();
    const ac = (el.autocomplete || '').toLowerCase();
    const hint = [el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' ').toLowerCase();
    if (t === 'password') return 'password';
    if (!['text', 'email', 'tel', 'number', ''].includes(t)) return null;
    if (ac.includes('one-time-code') || /\\b(otp|2fa|totp|passcode|verification|code)\\b/.test(hint)) return 'code';
    if (t === 'email' || ac.includes('email') || /e-?mail/.test(hint)) return 'email';
    if (ac.includes('username') || /user(name)?|login|account/.test(hint)) return 'text';
    return null;
  };
  for (const el of document.querySelectorAll('[data-patch-field]')) el.removeAttribute('data-patch-field');
  const found = [...document.querySelectorAll('input')].filter(visible).map((el) => ({ el, kind: kindOf(el) })).filter((f) => f.kind);
  const secret = found.find((f) => f.kind === 'password' || f.kind === 'code');
  const wordy = /sign.?in|log.?in|log on/i.test((document.title + ' ' + (document.body ? document.body.innerText : '')).slice(0, 6000));
  if (!secret && !(found.length > 0 && wordy)) return [];
  const anchor = secret || found[0];
  const form = anchor.el.form;
  const pick = found.filter((f) => !form || f.el.form === form).slice(0, 4);
  const named = { password: 'Password', email: 'Email', code: 'Code', text: 'Username' };
  return pick.map((f, i) => {
    const el = f.el;
    let label = el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.placeholder || '';
    label = label.replace(/\\s+/g, ' ').trim().slice(0, 40) || named[f.kind];
    el.setAttribute('data-patch-field', 'p' + i);
    return { field: 'p' + i, label, kind: f.kind };
  });
})()`;

/** The selected text, from a text field's selection or the page's. A password field gives nothing. */
const SELECTION_SCRIPT = `(() => {
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && typeof a.selectionStart === 'number') {
    if (a.type === 'password') return '';
    return a.value.slice(a.selectionStart, a.selectionEnd);
  }
  return String(getSelection() || '');
})()`;

function randomDelay(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

/** How long an agent call waits for the user to hand a taken-over tab back. */
export const USER_DRIVE_WAIT_MS = 10 * 60_000;

/** The sizes a viewer may lay a tab out at; outside them the view is letterboxed. */
const VIEWER_MIN = { width: 320, height: 240 };
const VIEWER_MAX = { width: 3840, height: 2400 };

/** Run in the page with the element and the text: selects the first occurrence of the text inside it. */
const SELECT_TEXT_BODY = `
  if (el.setSelectionRange && typeof el.value === 'string') {
    const i = el.value.indexOf(text);
    if (i < 0) return false;
    el.focus();
    el.setSelectionRange(i, i + text.length);
    return true;
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.nodeValue.indexOf(text);
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(n, i);
    range.setEnd(n, i + text.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }
  return false;
`;
const selectTextFn = new Function('el', 'text', SELECT_TEXT_BODY) as (
  el: unknown,
  text: string,
) => boolean;

/** An expression that writes the entries into the CURRENT origin's localStorage. */
function setLocalStorageExpr(entries: Array<[string, string]>): string {
  return `(() => { for (const [k, v] of ${JSON.stringify(entries)}) localStorage.setItem(k, v); })()`;
}

const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled', '--disable-gpu'];

/** `'direct'` or the routing host's hostId — what a launched context/browser's `proxy` was set from. */
type ProxyKey = 'direct' | string;

export class BrowserManager {
  private readonly tabsById = new Map<string, Tab>();
  private loggedInContext: BrowserContext | null = null;
  private loggedInContextProxyKey: ProxyKey | null = null;
  private ephemeralBrowser: Browser | null = null;
  private ephemeralBrowserProxyKey: ProxyKey | null = null;
  private xvfb: ChildProcess | null = null;
  private display: string | undefined;
  private playwrightMod: typeof import('playwright') | null = null;
  /** The Patch app's browser, while connected (`appBrowser`). */
  private appConnection: Browser | null = null;
  private appConnecting: Promise<Browser> | null = null;
  /** A throwaway context's route in the app: a context's own proxy, not a launch option. */
  private appThrowawayProxy: { server: string } | undefined;

  /** Tabs the user has taken over: the agent's tools refuse them until the hand-off ends. */
  private readonly handoffTabs = new Set<string>();

  /** Input-driving actions currently running, by id. */
  private readonly running = new Map<
    number,
    { action: string; startedAt: number; chatId: string | undefined }
  >();
  private runSeq = 0;
  /** Bumped by every `stop()`; a call that started under an older one is cancelled. */
  private stopGen = 0;
  /** Bumped by every `stopChat(chatId)`: cancels that chat's calls only. */
  private readonly chatStopGen = new Map<string, number>();
  private readonly chatLastStopped = new Map<string, number>();
  private lastStoppedAt: number | undefined;
  private activeTabId: string | undefined;
  private readonly downloads: DownloadEntry[] = [];
  private downloadSeq = 0;

  constructor(private readonly opts: BrowserManagerOptions) {}

  private notify(chatId: string | undefined): void {
    this.persistTabs();
    if (chatId === undefined) return;
    try {
      this.opts.onActivity?.(chatId);
    } catch (err) {
      this.opts.logger.warn({ err, chatId }, 'browser: activity listener failed');
    }
  }

  /** Settings → Computer use: is Patch driving this machine right now? */
  status(): ComputerUseStatus {
    this.pruneClosedTabs();
    const runs = [...this.running.values()];
    const current = runs.length > 0 ? runs[runs.length - 1]! : undefined;
    const since = runs.length > 0 ? Math.min(...runs.map((r) => r.startedAt)) : undefined;
    return {
      active: runs.length > 0,
      ...(current ? { action: current.action } : {}),
      ...(since !== undefined ? { since } : {}),
      tabs: this.tabsById.size,
      ...(this.lastStoppedAt !== undefined ? { lastStoppedAt: this.lastStoppedAt } : {}),
    };
  }

  /** One chat's browsing: what its surfaces show beside Watch and Stop. */
  statusForChat(chatId: string): ChatBrowserStatus {
    this.pruneClosedTabs();
    const runs = [...this.running.values()].filter((r) => r.chatId === chatId);
    const current = runs.length > 0 ? runs[runs.length - 1]! : undefined;
    const tabs = [...this.tabsById.values()]
      .filter((t) => t.ownerChatId === chatId)
      .map((t) => {
        const handedOff = this.handoffTabs.has(t.tabId);
        return {
          tabId: t.tabId,
          url: redactUrl(t.page.isClosed() ? t.lastUrl : t.page.url() || t.lastUrl),
          title: '',
          handedOff,
          driver: t.driver,
          ...(t.cursor ? { cursor: { ...t.cursor } } : {}),
          ...(t.appTarget ? { appTarget: t.appTarget } : {}),
          openedAt: t.openedAt,
        };
      });
    const lastStopped = this.chatLastStopped.get(chatId);
    return {
      chatId,
      active: runs.length > 0,
      ...(current ? { action: current.action } : {}),
      ...(runs.length > 0 ? { since: Math.min(...runs.map((r) => r.startedAt)) } : {}),
      ...(tabs.length > 0 ? { openedAt: Math.min(...tabs.map((t) => t.openedAt)) } : {}),
      tabs,
      ...(lastStopped !== undefined ? { lastStoppedAt: lastStopped } : {}),
    };
  }

  /**
   * Settings → Computer use → Stop. Closes every window the agent has open,
   * which makes whatever it was in the middle of fail with BrowserStoppedError.
   * Returns how many windows were closed.
   */
  async stop(): Promise<number> {
    this.stopGen += 1;
    this.lastStoppedAt = Date.now();
    const chats = new Set([...this.tabsById.values()].map((t) => t.ownerChatId));
    const closed = await this.closeAllTabs();
    for (const c of chats) this.notify(c);
    return closed;
  }

  /**
   * The Stop beside a chat's browser view: that chat's in-flight browser calls
   * fail with BrowserStoppedError and its tabs close. Other chats are untouched.
   */
  async stopChat(chatId: string): Promise<number> {
    this.chatStopGen.set(chatId, (this.chatStopGen.get(chatId) ?? 0) + 1);
    this.chatLastStopped.set(chatId, Date.now());
    const owned = [...this.tabsById.values()].filter((t) => t.ownerChatId === chatId);
    for (const tab of owned) {
      await this.close(tab.tabId).catch((err: unknown) => {
        this.opts.logger.warn({ chatId, err }, 'browser: error closing tab on chat stop');
      });
    }
    this.notify(chatId);
    return owned.length;
  }

  private async closeAllTabs(): Promise<number> {
    const tabs = [...this.tabsById.values()];
    this.tabsById.clear();
    this.handoffTabs.clear();
    this.persistTabs();
    for (const tab of tabs) {
      await tab.page.close().catch((err: unknown) => {
        this.opts.logger.warn({ err }, 'browser: error closing tab on stop');
      });
      await tab.ephemeralContext?.close().catch((err: unknown) => {
        this.opts.logger.warn({ err }, 'browser: error closing context on stop');
      });
    }
    return tabs.length;
  }

  open(opts: Parameters<BrowserManager['openImpl']>[0]): Promise<OpenResult> {
    return this.driving('Opening a page', () => this.openImpl(opts), { chatId: opts.chatId });
  }

  async click(tabId: string, ref: string): Promise<void> {
    await this.agentTurn(tabId);
    return this.driving('Clicking', () => this.clickImpl(tabId, ref), { tabId });
  }

  async type(tabId: string, ref: string, text: string, opts?: { submit?: boolean }): Promise<void> {
    await this.agentTurn(tabId);
    return this.driving('Typing', () => this.typeImpl(tabId, ref, text, opts), { tabId });
  }

  async fillForm(tabId: string, fields: { ref: string; value: string }[]): Promise<void> {
    await this.agentTurn(tabId);
    return this.driving('Filling in a form', () => this.fillFormImpl(tabId, fields), { tabId });
  }

  async select(tabId: string, ref: string, value: string): Promise<void> {
    await this.agentTurn(tabId);
    return this.driving('Choosing an option', () => this.selectImpl(tabId, ref, value), { tabId });
  }

  async upload(tabId: string, filePaths: string[], ref?: string): Promise<void> {
    await this.agentTurn(tabId);
    return this.driving('Choosing a file', () => this.uploadImpl(tabId, filePaths, ref), { tabId });
  }

  async pointer(tabId: string, req: PointerRequest): Promise<void> {
    await this.agentTurn(tabId);
    return this.driving('Moving the mouse', () => this.pointerImpl(tabId, req), { tabId });
  }

  async pressKeys(tabId: string, keys: string[]): Promise<void> {
    await this.agentTurn(tabId);
    return this.driving('Pressing keys', () => this.pressKeysImpl(tabId, keys), { tabId });
  }

  /** Runs an input-driving action, visible to `status()` and cancellable by `stop()` / `stopChat()`. */
  private async driving<T>(
    action: string,
    fn: () => Promise<T>,
    owner?: { tabId?: string; chatId?: string | undefined },
  ): Promise<T> {
    const chatId =
      owner?.chatId ?? (owner?.tabId ? this.tabsById.get(owner.tabId)?.ownerChatId : undefined);
    const gen = this.stopGen;
    const chatGen = chatId !== undefined ? (this.chatStopGen.get(chatId) ?? 0) : 0;
    const cancelled = (): boolean =>
      this.stopGen !== gen ||
      (chatId !== undefined && (this.chatStopGen.get(chatId) ?? 0) !== chatGen);
    const id = ++this.runSeq;
    this.running.set(id, { action, startedAt: Date.now(), chatId });
    this.notify(chatId);
    try {
      const result = await fn();
      if (cancelled()) {
        // Stopped while it ran (e.g. an open that finished after the sweep).
        if (this.stopGen !== gen) await this.closeAllTabs();
        else if (chatId !== undefined) await this.closeOwnedByChat(chatId);
        throw new BrowserStoppedError();
      }
      return result;
    } catch (err) {
      if (err instanceof BrowserStoppedError) throw err;
      if (cancelled()) throw new BrowserStoppedError();
      throw err;
    } finally {
      this.running.delete(id);
      this.notify(chatId);
    }
  }

  setWebBotAuth(config: WebBotAuthConfig | undefined): void {
    this.opts.webBotAuth = config;
  }

  private async playwright(): Promise<typeof import('playwright')> {
    if (this.playwrightMod) return this.playwrightMod;
    const load = this.opts.loadPlaywright ?? (() => import('playwright'));
    this.playwrightMod = await load();
    return this.playwrightMod;
  }

  /**
   * Signs every http(s) request this context makes. Per request, not per
   * context, because `@authority` changes with the target and each signature
   * carries its own created/expires/nonce. A signing failure aborts the
   * request loudly rather than sending it unsigned.
   */
  private async installSigning(context: BrowserContext): Promise<void> {
    await context.route(/^https?:/, async (route) => {
      const request = route.request();
      const cfg = this.opts.webBotAuth;
      if (!cfg) {
        await route.continue();
        return;
      }
      try {
        const signed = await cfg.sign(request.url());
        await route.continue({ headers: { ...request.headers(), ...signed } });
      } catch (err) {
        this.opts.logger.error({ err, url: request.url() }, 'browser: web-bot-auth signing failed');
        await route.abort('failed');
      }
    });
  }

  /**
   * Throws BrowserNotInstalledError with NO side effect when Chromium is
   * missing. Checked before every launch so a missing component always fails
   * the same clear way, never half-launches.
   */
  private async checkChromiumInstalled(): Promise<void> {
    if (this.usingApp()) return;
    const { chromium } = await this.playwright();
    const execPath = chromium.executablePath();
    if (!existsSync(execPath)) {
      throw new BrowserNotInstalledError(
        `Playwright's Chromium is not installed on this host (expected ${execPath}). ` +
          'Run `npx playwright install chromium` on this host, or install it from Settings → Hosts → Browser.',
      );
    }
  }

  /**
   * A real display to launch into. Reuses one already present (a desktop
   * host); on a headless Linux host it starts its own Xvfb — once, lazily —
   * and refuses clearly if Xvfb isn't installed, rather than falling back to
   * `headless: true`, which is the one thing "honest by design" forbids.
   */
  private async ensureDisplay(): Promise<string | undefined> {
    if (process.env['DISPLAY']) return process.env['DISPLAY'];
    if (this.display) return this.display;
    if (process.platform !== 'linux') return undefined;
    const probe = spawnSync('which', ['Xvfb']);
    if (probe.status !== 0) {
      throw new BrowserNotInstalledError(
        'this is a headless Linux host with no DISPLAY and no Xvfb to make one. ' +
          'Install it (e.g. `apt install xvfb`) and try again.',
      );
    }
    const display = this.opts.virtualDisplay ?? ':95';
    this.xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
    });
    this.xvfb.on('exit', (code) => {
      this.opts.logger.warn({ code }, 'browser: Xvfb exited');
      this.display = undefined;
      this.xvfb = null;
    });
    // The socket file alone races Chromium's own connect — Xvfb can create it
    // a beat before it actually accepts X11 protocol connections, which reads
    // to a launched browser as "Missing X server". `xdpyinfo` round-trips a
    // real protocol request, so it only succeeds once the server truly will.
    const deadline = Date.now() + 5000;
    for (;;) {
      if (spawnSync('xdpyinfo', ['-display', display]).status === 0) break;
      if (Date.now() > deadline) {
        throw new Error(`browser: Xvfb on ${display} never answered xdpyinfo in time`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    this.display = display;
    return display;
  }

  private async launchEnv(): Promise<Record<string, string> | undefined> {
    const display = await this.ensureDisplay();
    return display ? { ...process.env, DISPLAY: display } : undefined;
  }

  /**
   * spec/02 § Browser — Route through. A launched context/browser's `proxy`
   * is fixed for its whole life — Playwright has no way to re-point a
   * running one — so a `routeThrough` that differs from whichever key the
   * current one launched with closes it first. Closing takes every open tab
   * on that profile with it: there is no way to keep one running while its
   * network changes underneath it.
   */
  private async proxyFor(routeThrough?: RouteThrough): Promise<{
    key: ProxyKey;
    launchOpt: { server: string } | undefined;
  }> {
    if (!routeThrough) return { key: 'direct', launchOpt: undefined };
    if (!routeThrough.online) throw new RoutingHostOfflineError(routeThrough.hostName);
    return { key: routeThrough.hostId, launchOpt: { server: routeThrough.proxyServer! } };
  }

  /**
   * Closes every currently-tracked tab on `profile` (so `tabsById` and
   * reality agree — a bare `context.close()`/`browser.close()` leaves a
   * dangling entry whose `read`/`click`/etc. then throws Playwright's own
   * "Target closed" instead of `TabNotFoundError`) before closing the
   * context/browser itself.
   */
  private async closeTabsFor(profile: BrowserProfile): Promise<void> {
    for (const [tabId, tab] of [...this.tabsById]) {
      if (tab.profile !== profile) continue;
      await this.close(tabId).catch((err: unknown) => {
        this.opts.logger.warn(
          { tabId, err },
          'browser: error closing tab while re-launching for Route through',
        );
      });
    }
  }

  /**
   * One launch (or relaunch) at a time per profile. Two tabs opened together both
   * see "nothing running" and would each start a browser; the second then fights
   * the first for the locked profile directory, or orphans it.
   */
  private readonly launchLocks: Record<BrowserProfile, Promise<unknown>> = {
    'logged-in': Promise.resolve(),
    'logged-out': Promise.resolve(),
  };

  private serialised<T>(profile: BrowserProfile, fn: () => Promise<T>): Promise<T> {
    const run = this.launchLocks[profile].then(fn, fn);
    this.launchLocks[profile] = run.catch(() => undefined);
    return run;
  }

  /**
   * Whether the agent's browser is the Patch app's. Decided at the first
   * launch, not when the host starts: the app installed or updated after the
   * host came up still counts. Fixed from then for this host's life, since
   * tabs cannot move between the two.
   */
  private appDecided: boolean | undefined;
  private usingApp(): boolean {
    if (this.appDecided === undefined) {
      if (!this.opts.appBrowser) return false;
      this.appDecided = this.opts.appBrowser.present();
      if (this.appDecided)
        this.opts.logger.info('browser: the agent browser lives in the Patch app');
    }
    return this.appDecided;
  }

  /** The Patch app's browser, connected once and shared by both profiles. */
  private connectApp(): Promise<Browser> {
    if (this.appConnection?.isConnected()) return Promise.resolve(this.appConnection);
    if (this.appConnecting) return this.appConnecting;
    const link = this.opts.appBrowser!;
    this.appConnecting = (async () => {
      let endpoint: string;
      try {
        endpoint = await link.endpoint();
      } catch (err) {
        throw new AppBrowserUnavailableError(err instanceof Error ? err.message : String(err));
      }
      const { chromium } = await this.playwright();
      const browser = await chromium.connectOverCDP(endpoint).catch((err: unknown) => {
        throw new AppBrowserUnavailableError(
          `connecting to it failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      browser.on('disconnected', () => {
        if (this.appConnection !== browser) return;
        this.appConnection = null;
        this.loggedInContext = null;
        this.loggedInContextProxyKey = null;
        this.ephemeralBrowser = null;
        this.ephemeralBrowserProxyKey = null;
        this.markContextDead('logged-in', undefined, browser);
        this.markContextDead('logged-out', undefined, browser);
      });
      this.appConnection = browser;
      return browser;
    })().finally(() => {
      this.appConnecting = null;
    });
    return this.appConnecting;
  }

  /** In the app, the tab's DevTools target id, for the large view to show it as itself. */
  private async learnAppTarget(tab: Tab, page: Page): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    try {
      const { targetInfo } = (await cdp.send('Target.getTargetInfo')) as {
        targetInfo: { targetId: string };
      };
      if (tab.page === page) {
        tab.appTarget = targetInfo.targetId;
        this.notify(tab.ownerChatId);
      }
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  private getLoggedInContext(routeThrough?: RouteThrough): Promise<BrowserContext> {
    return this.serialised('logged-in', () => this.launchLoggedInContext(routeThrough));
  }

  private async launchLoggedInContext(routeThrough?: RouteThrough): Promise<BrowserContext> {
    const { key, launchOpt } = await this.proxyFor(routeThrough);
    if (this.loggedInContext && this.loggedInContextProxyKey !== key) {
      await this.closeTabsFor('logged-in');
      await this.loggedInContext.close();
      this.loggedInContext = null;
    }
    if (this.loggedInContext) return this.loggedInContext;
    if (this.usingApp()) {
      const browser = await this.connectApp();
      const context = browser.contexts()[0];
      if (!context) throw new AppBrowserUnavailableError('it offered no signed-in profile');
      // The app is not launched with a proxy: its profile is re-pointed instead.
      const session = await browser.newBrowserCDPSession();
      await session.send(
        'Patch.setProxy' as never,
        (launchOpt ? { proxyServer: launchOpt.server } : {}) as never,
      );
      await session.detach();
      await context.addInitScript(PATCH_WEBDRIVER_INIT_SCRIPT);
      await this.installSigning(context);
      context.on('close', () => {
        if (this.loggedInContext === context) {
          this.loggedInContext = null;
          this.loggedInContextProxyKey = null;
        }
        this.markContextDead('logged-in', context);
      });
      this.loggedInContext = context;
      this.loggedInContextProxyKey = key;
      return context;
    }
    await this.checkChromiumInstalled();
    const { chromium } = await this.playwright();
    const userDataDir = join(this.opts.root, 'profile');
    mkdirSync(userDataDir, { recursive: true });
    const env = await this.launchEnv();
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: LAUNCH_ARGS,
      ...(env ? { env } : {}),
      ...(launchOpt ? { proxy: launchOpt } : {}),
    });
    await context.addInitScript(PATCH_WEBDRIVER_INIT_SCRIPT);
    await this.installSigning(context);
    context.on('close', () => {
      if (this.loggedInContext === context) {
        this.loggedInContext = null;
        this.loggedInContextProxyKey = null;
      }
      this.markContextDead('logged-in', context);
    });
    this.loggedInContext = context;
    this.loggedInContextProxyKey = key;
    return context;
  }

  private getEphemeralBrowser(routeThrough?: RouteThrough): Promise<Browser> {
    return this.serialised('logged-out', () => this.launchEphemeralBrowser(routeThrough));
  }

  private async launchEphemeralBrowser(routeThrough?: RouteThrough): Promise<Browser> {
    const { key, launchOpt } = await this.proxyFor(routeThrough);
    if (this.usingApp()) {
      // One app browser for both profiles: a new route closes the throwaway
      // tabs, never the browser (that would take the signed-in tabs with it).
      if (this.ephemeralBrowser && this.ephemeralBrowserProxyKey !== key) {
        await this.closeTabsFor('logged-out');
      }
      const browser = await this.connectApp();
      this.appThrowawayProxy = launchOpt;
      this.ephemeralBrowser = browser;
      this.ephemeralBrowserProxyKey = key;
      return browser;
    }
    if (this.ephemeralBrowser && this.ephemeralBrowserProxyKey !== key) {
      await this.closeTabsFor('logged-out');
      await this.ephemeralBrowser.close();
      this.ephemeralBrowser = null;
    }
    if (this.ephemeralBrowser) return this.ephemeralBrowser;
    await this.checkChromiumInstalled();
    const { chromium } = await this.playwright();
    const env = await this.launchEnv();
    const browser = await chromium.launch({
      headless: false,
      args: LAUNCH_ARGS,
      ...(env ? { env } : {}),
      ...(launchOpt ? { proxy: launchOpt } : {}),
    });
    browser.on('disconnected', () => {
      if (this.ephemeralBrowser === browser) {
        this.ephemeralBrowser = null;
        this.ephemeralBrowserProxyKey = null;
      }
      this.markContextDead('logged-out', undefined, browser);
    });
    this.ephemeralBrowser = browser;
    this.ephemeralBrowserProxyKey = key;
    return browser;
  }

  // ---- Tab ids outlive a host restart ----------------------------------------

  private disposing = false;
  private readonly restoring = new Map<string, Promise<Tab>>();

  private get tabRegistryPath(): string {
    return join(this.opts.root, 'tabs.json');
  }

  /**
   * Writes the open logged-in tabs (id, owner, last address) so a restarted host
   * can reopen them under the same ids. Throwaway 'logged-out' tabs are not
   * kept: they hold no session worth resuming. Skipped while disposing, because
   * dispose closes tabs one by one and would otherwise wipe the list.
   */
  private persistTabs(): void {
    if (this.disposing) return;
    const entries: Record<string, PersistedTab> = {};
    for (const [tabId, tab] of this.tabsById) {
      if (tab.profile !== 'logged-in') continue;
      entries[tabId] = {
        url: tab.lastUrl,
        ...(tab.ownerChatId ? { ownerChatId: tab.ownerChatId } : {}),
      };
    }
    try {
      mkdirSync(this.opts.root, { recursive: true });
      const tmp = `${this.tabRegistryPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
      renameSync(tmp, this.tabRegistryPath);
    } catch (err) {
      this.opts.logger.warn({ err }, 'browser: could not save the tab list');
    }
  }

  private readPersistedTab(tabId: string): PersistedTab | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.tabRegistryPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      this.opts.logger.warn({ err }, 'browser: could not read the tab list');
      return undefined;
    }
    try {
      const entry = (JSON.parse(raw) as Record<string, PersistedTab>)[tabId];
      return entry && typeof entry.url === 'string' ? entry : undefined;
    } catch (err) {
      this.opts.logger.warn({ err }, 'browser: the tab list is corrupt, ignoring it');
      return undefined;
    }
  }

  /** A tab id this process has not seen but a previous run saved: reopened where it was. */
  private restoreTab(tabId: string, saved: PersistedTab): Promise<Tab> {
    let pending = this.restoring.get(tabId);
    if (!pending) {
      pending = (async () => {
        this.opts.logger.warn({ tabId }, 'browser: reopening tab saved before a host restart');
        const context = await this.getLoggedInContext();
        const page = await context.newPage();
        const tab = this.newTab({
          tabId,
          page,
          profile: 'logged-in',
          ownerChatId: saved.ownerChatId,
        });
        this.attachPage(tab, page);
        try {
          if (saved.url && saved.url !== 'about:blank') {
            await page.goto(saved.url, { waitUntil: 'domcontentloaded' });
          }
        } catch (err) {
          await page.close().catch(() => undefined);
          throw new Error(
            `tab ${tabId} was lost in a host restart and could not be reopened at ${redactUrl(saved.url)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        tab.lastUrl = saved.url;
        tab.notices.push(
          `this tab was lost when the host restarted and has been reopened at ${redactUrl(saved.url)}; anything not saved in the page (typed text, scroll, open menus) is gone, and refs from before must be re-read`,
        );
        this.tabsById.set(tabId, tab);
        this.activeTabId = tabId;
        this.notify(tab.ownerChatId);
        return tab;
      })().finally(() => this.restoring.delete(tabId));
      this.restoring.set(tabId, pending);
    }
    return pending;
  }

  requireTab(tabId: string): Tab {
    const tab = this.tabsById.get(tabId);
    if (!tab) throw new TabNotFoundError(tabId);
    return tab;
  }

  // ---- Reliability: a crashed tab or a closed browser heals itself ----------

  /**
   * The tab, healthy. A tab whose renderer crashed, or whose whole browser was
   * killed or closed, is rebuilt in place — same tabId, reloaded at the address
   * it was on — so the agent carries on without the user doing anything. What
   * the page held in memory (a half-filled form, scroll position) is gone, and
   * the agent is told so on its next read. A tab the user closed by hand is
   * simply gone: `TabNotFoundError`, never resurrected.
   */
  private async tabFor(tabId: string): Promise<Tab> {
    if (!this.tabsById.has(tabId)) {
      const saved = this.readPersistedTab(tabId);
      if (saved) await this.restoreTab(tabId, saved);
    }
    const tab = this.requireTab(tabId);
    if (tab.recovering) await tab.recovering;
    if (tab.crashed || (tab.page.isClosed() && tab.contextDead)) {
      tab.recovering = this.recover(tab).finally(() => {
        tab.recovering = undefined;
      });
      await tab.recovering;
    } else if (tab.page.isClosed()) {
      this.tabsById.delete(tabId);
      this.handoffTabs.delete(tabId);
      this.notify(tab.ownerChatId);
      throw new TabNotFoundError(tabId);
    }
    return tab;
  }

  private async recover(tab: Tab): Promise<void> {
    const reason = tab.crashed ? 'crashed' : 'its browser closed';
    this.opts.logger.warn({ tabId: tab.tabId, reason }, 'browser: recovering tab');
    const oldPage = tab.page;
    let page: Page;
    if (tab.profile === 'logged-in') {
      const context = tab.contextDead
        ? await this.getLoggedInContext(tab.routeThrough)
        : oldPage.context();
      page = await context.newPage();
    } else if (tab.contextDead) {
      if (!tab.ephemeralContext) {
        this.tabsById.delete(tab.tabId);
        this.notify(tab.ownerChatId);
        throw new TabNotFoundError(tab.tabId);
      }
      const browser = await this.getEphemeralBrowser(tab.routeThrough);
      const context = await this.newThrowawayContext(browser);
      tab.ephemeralContext = context;
      page = await context.newPage();
    } else {
      page = await oldPage.context().newPage();
    }
    if (!oldPage.isClosed()) await oldPage.close().catch(() => undefined);
    this.attachPage(tab, page);
    try {
      if (tab.lastUrl && tab.lastUrl !== 'about:blank') {
        await page.goto(tab.lastUrl, { waitUntil: 'domcontentloaded' });
      }
    } catch (err) {
      await page.close().catch(() => undefined);
      throw new Error(
        `tab ${tab.tabId} was lost (${reason}) and could not be reopened at ${redactUrl(tab.lastUrl)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    tab.page = page;
    tab.cdp = undefined;
    // A fresh page carries none of the old one's emulation: a viewer re-applies its size.
    tab.viewer = undefined;
    tab.crashed = false;
    tab.contextDead = false;
    tab.fileChooser = undefined;
    tab.armedDialog = undefined;
    tab.notices.push(
      `this tab was lost (${reason}) and has been reopened at ${redactUrl(tab.lastUrl)}; anything not saved in the page (typed text, scroll, open menus) is gone, and refs from before must be re-read`,
    );
  }

  private markContextDead(profile: BrowserProfile, context?: BrowserContext, browser?: Browser) {
    for (const tab of this.tabsById.values()) {
      if (tab.profile !== profile) continue;
      const pageContext = tab.page.context();
      if (context && pageContext !== context) continue;
      if (browser && pageContext.browser() !== browser) continue;
      tab.contextDead = true;
    }
  }

  /** Forgets tabs the user closed by hand. Tabs that died with their browser stay, to be recovered. */
  private pruneClosedTabs(): void {
    for (const [tabId, tab] of [...this.tabsById]) {
      if (!tab.page.isClosed() || tab.contextDead || tab.recovering) continue;
      this.tabsById.delete(tabId);
      this.handoffTabs.delete(tabId);
      this.notify(tab.ownerChatId);
    }
  }

  private async newThrowawayContext(browser: Browser): Promise<BrowserContext> {
    const context = await browser.newContext(
      this.usingApp() && this.appThrowawayProxy ? { proxy: this.appThrowawayProxy } : {},
    );
    await context.addInitScript(PATCH_WEBDRIVER_INIT_SCRIPT);
    await this.installSigning(context);
    return context;
  }

  // ---- Everything a page does on its own, kept for the agent to ask about ----

  private newTab(init: {
    tabId: string;
    page: Page;
    profile: BrowserProfile;
    ownerChatId?: string | undefined;
    routedVia?: string | undefined;
    routeThrough?: RouteThrough | undefined;
    openerTabId?: string | undefined;
    ephemeralContext?: BrowserContext | undefined;
  }): Tab {
    return {
      tabId: init.tabId,
      page: init.page,
      profile: init.profile,
      ...(init.ephemeralContext ? { ephemeralContext: init.ephemeralContext } : {}),
      ...(init.ownerChatId ? { ownerChatId: init.ownerChatId } : {}),
      ...(init.routedVia ? { routedVia: init.routedVia } : {}),
      ...(init.routeThrough ? { routeThrough: init.routeThrough } : {}),
      ...(init.openerTabId ? { openerTabId: init.openerTabId } : {}),
      lastUrl: init.page.url(),
      crashed: false,
      contextDead: false,
      notices: [],
      consoleLog: [],
      network: [],
      responses: new Map(),
      requestIds: new WeakMap(),
      dialogs: [],
      frameNumbers: new WeakMap(),
      nextFrameNumber: 0,
      openedAt: Date.now(),
      driver: 'agent',
      driverWaiters: [],
    };
  }

  private requestSeq = 0;

  private attachPage(tab: Tab, page: Page): void {
    const cap = <T>(list: T[], max: number): void => {
      if (list.length > max) list.splice(0, list.length - max);
    };
    page.on('console', (msg) => {
      tab.consoleLog.push({
        type: msg.type(),
        text: msg.text(),
        ...(msg.location().url ? { url: msg.location().url } : {}),
        at: Date.now(),
      });
      cap(tab.consoleLog, 500);
    });
    page.on('pageerror', (err) => {
      tab.consoleLog.push({ type: 'pageerror', text: err.message, at: Date.now() });
      cap(tab.consoleLog, 500);
    });
    page.on('request', (req) => {
      const id = ++this.requestSeq;
      tab.requestIds.set(req, id);
      tab.network.push({
        id,
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        startedAt: Date.now(),
      });
      if (tab.network.length > 500) {
        for (const dropped of tab.network.splice(0, tab.network.length - 500)) {
          tab.responses.delete(dropped.id);
        }
      }
    });
    const entryFor = (req: object): NetworkEntry | undefined => {
      const id = tab.requestIds.get(req);
      return id === undefined ? undefined : tab.network.find((e) => e.id === id);
    };
    page.on('response', (res) => {
      const entry = entryFor(res.request());
      if (!entry) return;
      entry.status = res.status();
      entry.statusText = res.statusText();
      entry.mimeType = res.headers()['content-type'] ?? '';
      tab.responses.set(entry.id, res);
    });
    page.on('requestfinished', (req) => {
      const entry = entryFor(req);
      if (entry) entry.ms = Date.now() - entry.startedAt;
    });
    page.on('requestfailed', (req) => {
      const entry = entryFor(req);
      if (entry) entry.failure = req.failure()?.errorText ?? 'failed';
    });
    page.on('dialog', (dialog) => {
      const type = dialog.type();
      const armed = tab.armedDialog;
      let accept: boolean;
      let promptText: string | undefined;
      let auto = true;
      if (type === 'alert' || type === 'beforeunload') {
        // Only one answer exists; refusing a beforeunload would trap the tab.
        accept = true;
      } else if (armed) {
        accept = armed.accept;
        promptText = armed.promptText;
        auto = false;
        tab.armedDialog = undefined;
      } else {
        // NO silent yes: an unexpected confirm/prompt is declined and recorded.
        accept = false;
      }
      tab.dialogs.push({
        type,
        message: dialog.message(),
        ...(dialog.defaultValue() ? { defaultValue: dialog.defaultValue() } : {}),
        handled: accept ? 'accepted' : 'dismissed',
        auto,
        at: Date.now(),
      });
      cap(tab.dialogs, 100);
      const answered = accept ? dialog.accept(promptText) : dialog.dismiss();
      answered.catch((err: unknown) => {
        this.opts.logger.warn({ err, tabId: tab.tabId }, 'browser: could not answer dialog');
      });
    });
    page.on('download', (download) => this.saveDownload(tab, download));
    page.on('filechooser', (chooser) => {
      // Held, not opened: a native picker has no user to answer it. patch_browser_upload fills it.
      tab.fileChooser = chooser;
    });
    page.on('popup', (popup) => this.adoptPopup(tab, popup));
    page.on('crash', () => {
      this.opts.logger.warn({ tabId: tab.tabId }, 'browser: tab crashed');
      tab.crashed = true;
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (url && url !== 'about:blank') {
        tab.lastUrl = url;
        if (this.tabsById.get(tab.tabId) === tab) this.persistTabs();
      }
      tab.fileChooser = undefined;
    });
    if (this.usingApp()) {
      tab.appTarget = undefined;
      this.learnAppTarget(tab, page).catch((err: unknown) => {
        this.opts.logger.warn({ err, tabId: tab.tabId }, 'browser: could not learn the app tab id');
      });
    }
  }

  /** A target=_blank link or window.open: a tab of its own, owned by the same chat. */
  private adoptPopup(opener: Tab, popup: Page): void {
    const tabId = randomUUID();
    const tab = this.newTab({
      tabId,
      page: popup,
      profile: opener.profile,
      ownerChatId: opener.ownerChatId,
      routedVia: opener.routedVia,
      routeThrough: opener.routeThrough,
      openerTabId: opener.tabId,
    });
    this.attachPage(tab, popup);
    this.tabsById.set(tabId, tab);
    this.activeTabId = tabId;
    this.notify(opener.ownerChatId);
  }

  private saveDownload(tab: Tab, download: Download): void {
    const filename = download.suggestedFilename();
    const entry: DownloadEntry = {
      tabId: tab.tabId,
      filename,
      url: redactUrl(download.url()),
      state: 'saving',
      at: Date.now(),
    };
    this.downloads.push(entry);
    if (this.downloads.length > 200) this.downloads.shift();
    const dir = join(this.opts.root, 'downloads', tab.tabId);
    mkdirSync(dir, { recursive: true });
    const safe = filename.replace(/[^\w.\- ]/g, '_') || 'download';
    const dest = join(dir, `${++this.downloadSeq}-${safe}`);
    download
      .saveAs(dest)
      .then(() => {
        entry.state = 'done';
        entry.path = dest;
        entry.bytes = statSync(dest).size;
      })
      .catch((err: unknown) => {
        entry.state = 'failed';
        entry.error = err instanceof Error ? err.message : String(err);
        this.opts.logger.warn({ err, tabId: tab.tabId }, 'browser: download failed');
      });
  }

  /** `patch_browser_downloads`: what the tab (or every tab) downloaded, as files on THIS host. */
  async downloadsOf(tabId: string | undefined, waitMs = 0): Promise<DownloadEntry[]> {
    if (tabId) await this.agentTurn(tabId);
    const deadline = Date.now() + waitMs;
    const pick = (): DownloadEntry[] =>
      this.downloads.filter((d) => (tabId ? d.tabId === tabId : true));
    while (
      waitMs > 0 &&
      (pick().length === 0 || pick().some((d) => d.state === 'saving')) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return pick().map((d) => ({ ...d }));
  }

  private locatorFor(tab: Tab, ref: string): Locator {
    return tab.page.locator(`[data-patch-ref="${ref}"]`);
  }

  /** The element a ref names, wherever it lives: the top frame, an iframe, an open shadow root. */
  private async requireLocator(tab: Tab, ref: string): Promise<Locator> {
    if (!/^[A-Za-z0-9]+$/.test(ref)) throw new RefNotFoundError(ref);
    const sel = `[data-patch-ref="${ref}"]`;
    for (const frame of tab.page.frames()) {
      const locator = frame.locator(sel);
      if ((await locator.count()) > 0) return locator.first();
    }
    throw new RefNotFoundError(ref);
  }

  /** `patch_browser_open`. */
  async openImpl(opts: {
    url: string;
    profile?: BrowserProfile;
    chatId?: string;
    /** spec/02 § Browser — Route through. Omitted = direct, as always. */
    routeThrough?: RouteThrough;
  }): Promise<OpenResult> {
    const profile = opts.profile ?? 'logged-in';
    let page: Page;
    let ephemeralContext: BrowserContext | undefined;
    if (profile === 'logged-in') {
      const context = await this.getLoggedInContext(opts.routeThrough);
      page = await context.newPage();
    } else {
      const browser = await this.getEphemeralBrowser(opts.routeThrough);
      ephemeralContext = await this.newThrowawayContext(browser);
      page = await ephemeralContext.newPage();
    }
    const tabId = randomUUID();
    const routedVia = opts.routeThrough?.hostName;
    const tab = this.newTab({
      tabId,
      page,
      profile,
      ownerChatId: opts.chatId,
      routedVia,
      routeThrough: opts.routeThrough,
      ephemeralContext,
    });
    this.attachPage(tab, page);
    let loading = false;
    try {
      await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        // Not a failure: a bot check ("verify you are human") never reaches
        // domcontentloaded. Keep the tab so a person can see it and click through.
        loading = true;
      } else {
        // The tab was never tracked, so nothing else would ever close it.
        await page.close().catch((closeErr: unknown) => {
          this.opts.logger.warn({ err: closeErr }, 'browser: error closing tab after failed open');
        });
        await ephemeralContext?.close().catch((closeErr: unknown) => {
          this.opts.logger.warn(
            { err: closeErr },
            'browser: error closing context after failed open',
          );
        });
        throw err;
      }
    }
    this.tabsById.set(tabId, tab);
    this.activeTabId = tabId;
    this.notify(opts.chatId);
    return {
      tabId,
      // A page stuck mid-load may never answer for its title.
      title: loading ? '' : await page.title(),
      url: page.url(),
      ...(loading ? { loading: true as const } : {}),
      ...(routedVia ? { routedVia } : {}),
    };
  }

  // ---- Reading ---------------------------------------------------------------

  /**
   * `patch_browser_read`. `mode`:
   *  - `snapshot` (default): every visible interactive element with a stable
   *    `ref`, across iframes and open shadow roots.
   *  - `text`: the page's visible text (or one element's), untruncated up to
   *    `maxChars`.
   *  - `structured`: headings, tables, lists, links and the article body, as data.
   *  - `accessibility`: the browser's own accessibility tree (YAML).
   */
  async read(
    tabId: string,
    opts: {
      mode?: 'snapshot' | 'text' | 'structured' | 'accessibility';
      ref?: string;
      maxChars?: number;
    } = {},
  ): Promise<ReadResult> {
    await this.agentTurn(tabId);
    const tab = await this.tabFor(tabId);
    const mode = opts.mode ?? 'snapshot';
    const maxChars = opts.maxChars ?? 50_000;
    const result: ReadResult = {
      title: await tab.page.title(),
      url: tab.page.url(),
      mode,
    };
    if (mode === 'snapshot') {
      result.snapshot = await this.snapshotFrames(tab);
    } else if (mode === 'text') {
      const text = await this.pageText(tab, opts.ref);
      result.text = text.length > maxChars ? text.slice(0, maxChars) : text;
      if (text.length > maxChars) result.truncated = true;
    } else if (mode === 'structured') {
      result.structured = (await tab.page.evaluate(STRUCTURED_SCRIPT)) as StructuredContent;
      if (result.structured.article.length > maxChars) {
        result.structured.article = result.structured.article.slice(0, maxChars);
        result.truncated = true;
      }
    } else {
      const target = opts.ref ? await this.requireLocator(tab, opts.ref) : tab.page.locator('body');
      const tree = await target.ariaSnapshot();
      result.accessibility = tree.length > maxChars ? tree.slice(0, maxChars) : tree;
      if (tree.length > maxChars) result.truncated = true;
    }
    if (tab.fileChooser) result.fileChooserOpen = true;
    if (tab.notices.length > 0) result.notices = tab.notices.splice(0);
    return result;
  }

  private frameNumber(tab: Tab, frame: Frame): number {
    let n = tab.frameNumbers.get(frame);
    if (n === undefined) {
      n = ++tab.nextFrameNumber;
      tab.frameNumbers.set(frame, n);
    }
    return n;
  }

  private async snapshotFrames(tab: Tab): Promise<SnapshotNode[]> {
    const out: SnapshotNode[] = [];
    const main = tab.page.mainFrame();
    for (const frame of tab.page.frames()) {
      const isMain = frame === main;
      const prefix = isMain ? '' : `f${this.frameNumber(tab, frame)}`;
      let nodes: SnapshotNode[];
      try {
        nodes = (await frame.evaluate(snapshotScript(prefix))) as SnapshotNode[];
      } catch (err) {
        if (isMain) throw err;
        // An iframe that detached mid-read has nothing left to report.
        this.opts.logger.info({ err, url: frame.url() }, 'browser: skipped a frame while reading');
        continue;
      }
      if (!isMain) for (const n of nodes) n.frame = frame.url();
      out.push(...nodes);
    }
    return out;
  }

  private async pageText(tab: Tab, ref: string | undefined): Promise<string> {
    if (ref) {
      await this.requireLocator(tab, ref);
      for (const frame of tab.page.frames()) {
        const text = (await frame.evaluate(textScript(ref))) as string | null;
        if (text !== null) return text;
      }
      throw new RefNotFoundError(ref);
    }
    const parts: string[] = [];
    const main = tab.page.mainFrame();
    for (const frame of tab.page.frames()) {
      let text: string | null;
      try {
        text = (await frame.evaluate(textScript(undefined))) as string | null;
      } catch (err) {
        if (frame === main) throw err;
        continue;
      }
      if (!text) continue;
      parts.push(frame === main ? text : `[iframe ${frame.url()}]\n${text}`);
    }
    return parts.join('\n\n');
  }

  // ---- Navigation, tabs and waiting -----------------------------------------

  /** `patch_browser_navigate`: move an existing tab; no new tab. */
  async navigate(
    tabId: string,
    action: 'goto' | 'back' | 'forward' | 'reload',
    url?: string,
  ): Promise<{ title: string; url: string; status?: number }> {
    await this.agentTurn(tabId);
    return this.driving(
      'Navigating',
      async () => {
        const tab = await this.tabFor(tabId);
        let status: number | undefined;
        const opts = { waitUntil: 'domcontentloaded' } as const;
        if (action === 'goto') {
          if (!url) throw new Error('goto needs a url');
          status = (await tab.page.goto(url, opts))?.status();
        } else if (action === 'reload') {
          status = (await tab.page.reload(opts))?.status();
        } else {
          const before = tab.page.url();
          const res =
            action === 'back' ? await tab.page.goBack(opts) : await tab.page.goForward(opts);
          // Playwright answers null when there is no entry to move to; a fresh tab's own
          // blank starting page is not somewhere a person could go back to either.
          if (!res && tab.page.url() === before) throw new Error(`no page to go ${action} to`);
          if (tab.page.url() === 'about:blank') {
            await tab.page.goForward(opts).catch(() => undefined);
            throw new Error(`no page to go ${action} to`);
          }
          status = res?.status();
        }
        return {
          title: await tab.page.title(),
          url: tab.page.url(),
          ...(status !== undefined ? { status } : {}),
        };
      },
      { tabId },
    );
  }

  /** `patch_browser_switch_tab`: bring a tab to the front, the way a person clicks its tab. */
  async switchTo(tabId: string): Promise<{ tabId: string; title: string; url: string }> {
    await this.agentTurn(tabId);
    const tab = await this.tabFor(tabId);
    await tab.page.bringToFront();
    this.activeTabId = tabId;
    return { tabId, title: await tab.page.title(), url: tab.page.url() };
  }

  /**
   * `patch_browser_wait`. Each condition given is waited for in turn:
   * `text` appearing, `textGone`, a `selector` reaching `state`, a `ref`
   * leaving the page, the address containing `url`, the network going `idle`,
   * or a plain pause of `ms`.
   */
  async waitFor(
    tabId: string,
    c: {
      text?: string;
      textGone?: string;
      selector?: string;
      state?: 'visible' | 'hidden' | 'attached' | 'detached';
      ref?: string;
      url?: string;
      networkIdle?: boolean;
      ms?: number;
      timeoutMs?: number;
    },
  ): Promise<{ title: string; url: string; waitedMs: number }> {
    await this.agentTurn(tabId);
    const given = [c.text, c.textGone, c.selector, c.ref, c.url, c.networkIdle, c.ms];
    if (given.every((g) => g === undefined || g === false)) {
      throw new Error('wait needs one of text, textGone, selector, ref, url, networkIdle or ms');
    }
    return this.driving(
      'Waiting',
      async () => {
        const tab = await this.tabFor(tabId);
        const started = Date.now();
        const timeout = Math.min(c.timeoutMs ?? 30_000, 120_000);
        const left = (): number => Math.max(1, timeout - (Date.now() - started));
        const page = tab.page;
        if (c.ms !== undefined) await page.waitForTimeout(Math.min(c.ms, 30_000));
        if (c.url !== undefined) {
          const want = c.url;
          await page.waitForURL((u) => u.href.includes(want), { timeout: left() });
        }
        if (c.text !== undefined) {
          await page.waitForFunction(
            `!!document.body && document.body.innerText.includes(${JSON.stringify(c.text)})`,
            undefined,
            { timeout: left() },
          );
        }
        if (c.textGone !== undefined) {
          await page.waitForFunction(
            `!document.body || !document.body.innerText.includes(${JSON.stringify(c.textGone)})`,
            undefined,
            { timeout: left() },
          );
        }
        if (c.selector !== undefined) {
          await page
            .locator(c.selector)
            .first()
            .waitFor({ state: c.state ?? 'visible', timeout: left() });
        }
        if (c.ref !== undefined) {
          const state = c.state ?? 'detached';
          if (state === 'detached' || state === 'hidden') {
            await this.locatorFor(tab, c.ref).first().waitFor({ state, timeout: left() });
          } else {
            const locator = await this.requireLocator(tab, c.ref);
            await locator.waitFor({ state, timeout: left() });
          }
        }
        if (c.networkIdle) await page.waitForLoadState('networkidle', { timeout: left() });
        return {
          title: await page.title(),
          url: page.url(),
          waitedMs: Date.now() - started,
        };
      },
      { tabId },
    );
  }

  // ---- Interaction -------------------------------------------------------------

  /** An element by ref, or by a CSS / Playwright selector for what has no ref (a paragraph, a drop zone). */
  private async target(tab: Tab, t: { ref?: string; selector?: string }): Promise<Locator> {
    if (t.ref) return this.requireLocator(tab, t.ref);
    if (t.selector) {
      const locator = tab.page.locator(t.selector).first();
      if ((await locator.count()) === 0) throw new Error(`no element matches "${t.selector}"`);
      return locator;
    }
    throw new Error('name the element with a ref (from patch_browser_read) or a selector');
  }

  /** `patch_browser_interact`: the things a person does that are not a click or typing. */
  async interact(
    tabId: string,
    req:
      | ({ action: 'hover' | 'scroll_to' } & ElementTarget)
      | ({ action: 'drag'; toRef?: string; toSelector?: string } & ElementTarget)
      | ({ action: 'press'; keys: string[] } & ElementTarget)
      | ({ action: 'select_text'; text?: string } & ElementTarget)
      | { action: 'copy' | 'paste' }
      | { action: 'clipboard_read' }
      | { action: 'clipboard_write'; text: string },
  ): Promise<{ text?: string }> {
    await this.agentTurn(tabId);
    return this.driving(
      'Interacting',
      async () => {
        const tab = await this.tabFor(tabId);
        const page = tab.page;
        switch (req.action) {
          case 'hover': {
            const el = await this.target(tab, req);
            await page.waitForTimeout(randomDelay(50, 150));
            await el.hover();
            return {};
          }
          case 'scroll_to': {
            const el = await this.target(tab, req);
            await el.scrollIntoViewIfNeeded();
            return {};
          }
          case 'drag': {
            const from = await this.target(tab, req);
            const to = await this.target(tab, {
              ...(req.toRef ? { ref: req.toRef } : {}),
              ...(req.toSelector ? { selector: req.toSelector } : {}),
            });
            await page.waitForTimeout(randomDelay(50, 150));
            await from.dragTo(to);
            return {};
          }
          case 'press': {
            if (req.keys.length === 0) throw new Error('press at least one key');
            const el = await this.target(tab, req);
            await el.focus();
            for (const key of req.keys) {
              await page.keyboard.press(key, { delay: randomDelay(30, 90) });
              await page.waitForTimeout(randomDelay(30, 90));
            }
            return {};
          }
          case 'select_text': {
            const el = await this.target(tab, req);
            if (req.text === undefined) {
              await el.selectText();
            } else {
              const found = await el.evaluate(selectTextFn, req.text);
              if (!found) throw new Error(`the text "${req.text}" is not in that element`);
            }
            return {};
          }
          case 'copy':
            await page.keyboard.press('ControlOrMeta+c');
            return {};
          case 'paste':
            await page.keyboard.press('ControlOrMeta+v');
            return {};
          case 'clipboard_read': {
            await this.grantClipboard(tab);
            const text = (await page.evaluate('navigator.clipboard.readText()')) as string;
            return { text };
          }
          case 'clipboard_write': {
            await this.grantClipboard(tab);
            await page.evaluate(`navigator.clipboard.writeText(${JSON.stringify(req.text)})`);
            return {};
          }
        }
      },
      { tabId },
    );
  }

  private async grantClipboard(tab: Tab): Promise<void> {
    const url = tab.page.url();
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      throw new Error(`the clipboard needs a loaded http(s) page; this tab is at "${url}"`);
    }
    const secure = (await tab.page.evaluate('window.isSecureContext')) as boolean;
    if (!secure) {
      throw new Error(
        `the clipboard is only available to a secure page (https, or localhost); ${origin} is not. Use copy/paste keys instead.`,
      );
    }
    await tab.page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  }

  /** `patch_browser_dialog`: arm the answer to the NEXT confirm/prompt, or read what dialogs did. */
  dialog(
    tabId: string,
    req: { accept?: boolean; promptText?: string },
  ): { armed: boolean; dialogs: DialogEntry[] } {
    this.assertAgentTurnNow(tabId);
    const tab = this.requireTab(tabId);
    if (req.accept !== undefined) {
      tab.armedDialog = {
        accept: req.accept,
        ...(req.promptText !== undefined ? { promptText: req.promptText } : {}),
      };
    }
    return { armed: tab.armedDialog !== undefined, dialogs: tab.dialogs.map((d) => ({ ...d })) };
  }

  // ---- State ---------------------------------------------------------------------

  /** Cookies and localStorage of the tab's browser context (the whole profile, not just this tab). */
  async stateGet(tabId: string, domain?: string): Promise<StorageState> {
    await this.agentTurn(tabId);
    const tab = await this.tabFor(tabId);
    const state = (await tab.page.context().storageState()) as unknown as StorageState;
    if (!domain) return state;
    const match = (d: string): boolean => d.replace(/^\./, '').endsWith(domain.replace(/^\./, ''));
    return {
      cookies: state.cookies.filter((c) => match(String(c['domain'] ?? ''))),
      origins: state.origins.filter((o) => {
        try {
          return match(new URL(o.origin).hostname);
        } catch {
          return false;
        }
      }),
    };
  }

  /**
   * Put cookies and localStorage into the tab's browser context — a saved
   * sign-in. `localStorage` goes to the tab's current origin; `origins` names
   * others, written without touching the network.
   */
  async stateSet(
    tabId: string,
    state: {
      cookies?: Array<Record<string, unknown>>;
      origins?: StorageState['origins'];
      localStorage?: Record<string, string>;
    },
  ): Promise<{ cookies: number; origins: number; localStorageKeys: number }> {
    await this.agentTurn(tabId);
    const tab = await this.tabFor(tabId);
    const context = tab.page.context();
    let keys = 0;
    if (state.cookies && state.cookies.length > 0) {
      await context.addCookies(
        state.cookies as unknown as Parameters<BrowserContext['addCookies']>[0],
      );
    }
    for (const o of state.origins ?? []) {
      await this.writeLocalStorage(context, o.origin, o.localStorage);
      keys += o.localStorage.length;
    }
    if (state.localStorage) {
      const entries = Object.entries(state.localStorage);
      await tab.page.evaluate(setLocalStorageExpr(entries));
      keys += entries.length;
    }
    return {
      cookies: state.cookies?.length ?? 0,
      origins: state.origins?.length ?? 0,
      localStorageKeys: keys,
    };
  }

  private async writeLocalStorage(
    context: BrowserContext,
    origin: string,
    items: Array<{ name: string; value: string }>,
  ): Promise<void> {
    if (items.length === 0) return;
    const page = await context.newPage();
    try {
      await page.route(`${origin}/**`, (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }),
      );
      await page.goto(`${origin}/__patch_storage`);
      await page.evaluate(
        setLocalStorageExpr(items.map((i) => [i.name, i.value] as [string, string])),
      );
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /** Save the whole storage state to a file on THIS host (mode 600), returning only counts. */
  async stateSave(
    tabId: string,
    path: string,
    domain?: string,
  ): Promise<{ path: string; cookies: number; origins: number }> {
    const state = await this.stateGet(tabId, domain);
    writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
    return { path, cookies: state.cookies.length, origins: state.origins.length };
  }

  /** Load a storage state file written by `stateSave` (or Playwright's own) into the tab's context. */
  async stateLoad(
    tabId: string,
    path: string,
  ): Promise<{ cookies: number; origins: number; localStorageKeys: number }> {
    let parsed: Partial<StorageState>;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StorageState>;
    } catch (err) {
      throw new Error(
        `could not read a storage state from ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.stateSet(tabId, {
      ...(parsed.cookies ? { cookies: parsed.cookies } : {}),
      ...(parsed.origins ? { origins: parsed.origins } : {}),
    });
  }

  /** Clear the context's cookies and/or the current origin's localStorage. */
  async stateClear(
    tabId: string,
    what: { cookies?: boolean; localStorage?: boolean },
  ): Promise<void> {
    await this.agentTurn(tabId);
    const tab = await this.tabFor(tabId);
    if (what.cookies) await tab.page.context().clearCookies();
    if (what.localStorage) await tab.page.evaluate('localStorage.clear()');
  }

  // ---- Debugging -----------------------------------------------------------------

  /** `patch_browser_eval`: run JavaScript in the page (or one frame) and return its JSON value. */
  async evaluate(
    tabId: string,
    expression: string,
    opts: { frameUrl?: string; maxChars?: number } = {},
  ): Promise<{ value: unknown; truncated?: boolean }> {
    await this.agentTurn(tabId);
    const tab = await this.tabFor(tabId);
    let target: Page | Frame = tab.page;
    if (opts.frameUrl) {
      const frame = tab.page.frames().find((f) => f.url().includes(opts.frameUrl!));
      if (!frame) throw new Error(`no frame whose address contains "${opts.frameUrl}"`);
      target = frame;
    }
    // A string is never called for us: wrap so both `document.title` and `() => …` work.
    const wrapped = `(async () => { const __v = (${expression}\n); return typeof __v === 'function' ? await __v() : await __v; })()`;
    const raw = (await target.evaluate(wrapped)) as unknown;
    const json = JSON.stringify(raw === undefined ? null : raw);
    const max = opts.maxChars ?? 100_000;
    if (json !== undefined && json.length > max) {
      return { value: json.slice(0, max), truncated: true };
    }
    return { value: raw === undefined ? null : raw };
  }

  consoleMessages(
    tabId: string,
    opts: { level?: string; limit?: number; clear?: boolean } = {},
  ): ConsoleEntry[] {
    this.assertAgentTurnNow(tabId);
    const tab = this.requireTab(tabId);
    let list = tab.consoleLog.filter((e) => !opts.level || e.type === opts.level);
    list = list.slice(-(opts.limit ?? 100));
    if (opts.clear) tab.consoleLog.length = 0;
    return list.map((e) => ({ ...e }));
  }

  networkRequests(
    tabId: string,
    opts: { urlContains?: string; limit?: number; clear?: boolean } = {},
  ): NetworkEntry[] {
    this.assertAgentTurnNow(tabId);
    const tab = this.requireTab(tabId);
    let list = tab.network.filter((e) => !opts.urlContains || e.url.includes(opts.urlContains));
    list = list.slice(-(opts.limit ?? 100));
    const out = list.map((e) => ({ ...e }));
    if (opts.clear) {
      tab.network.length = 0;
      tab.responses.clear();
    }
    return out;
  }

  /** The body of a response `networkRequests` listed, as text (or a note for binary). */
  async responseBody(
    tabId: string,
    id: number,
    maxChars = 100_000,
  ): Promise<{ id: number; mimeType: string; text?: string; bytes: number; truncated?: boolean }> {
    await this.agentTurn(tabId);
    const tab = this.requireTab(tabId);
    const res = tab.responses.get(id);
    if (!res)
      throw new Error(`no response recorded for request ${id} (never finished, or aged out)`);
    let body: Buffer;
    try {
      body = await res.body();
    } catch (err) {
      throw new Error(
        `the body of request ${id} is no longer available (the browser drops it once the page navigates away): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const mimeType = res.headers()['content-type'] ?? '';
    if (!/^(text\/|application\/(json|javascript|xml|x-www-form))|\+(json|xml)/.test(mimeType)) {
      return { id, mimeType, bytes: body.length };
    }
    const text = body.toString('utf8');
    return text.length > maxChars
      ? { id, mimeType, bytes: body.length, text: text.slice(0, maxChars), truncated: true }
      : { id, mimeType, bytes: body.length, text };
  }

  /**
   * `patch_browser_viewport`: resize the tab, emulate a named device (viewport,
   * pixel ratio, touch, mobile user agent) or put it back. The user agent
   * changes ONLY when a device is asked for, never otherwise.
   */
  async setViewport(
    tabId: string,
    req: { width?: number; height?: number; device?: string; reset?: boolean },
  ): Promise<{ width: number; height: number; userAgent: string; devicePixelRatio: number }> {
    await this.agentTurn(tabId);
    const tab = await this.tabFor(tabId);
    const page = tab.page;
    if (!tab.cdp) tab.cdp = await page.context().newCDPSession(page);
    const cdp = tab.cdp;
    // The agent's own size wins over a live view's: the view letterboxes from now on.
    if (tab.viewer) {
      tab.viewer = undefined;
      tab.viewerYielded = true;
      await cdp.send('Emulation.clearDeviceMetricsOverride');
    }
    tab.agentDevice = Boolean(req.device) && !req.reset;
    {
      if (req.reset) {
        await cdp.send('Emulation.clearDeviceMetricsOverride');
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' });
        await page.setViewportSize(DEFAULT_VIEWPORT);
      } else if (req.device) {
        const { devices } = await this.playwright();
        const d = devices[req.device];
        if (!d) {
          const names = Object.keys(devices).filter((n) => !n.includes('landscape'));
          throw new Error(
            `unknown device "${req.device}"; some that exist: ${names.slice(0, 25).join(', ')}`,
          );
        }
        await page.setViewportSize(d.viewport);
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: d.userAgent });
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: d.viewport.width,
          height: d.viewport.height,
          deviceScaleFactor: d.deviceScaleFactor,
          mobile: d.isMobile,
        });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: d.hasTouch });
      } else {
        const size = await this.viewport(tabId);
        const width = req.width ?? size.width;
        const height = req.height ?? size.height;
        if (width < 100 || height < 100 || width > 7680 || height > 4320) {
          throw new Error('viewport must be between 100x100 and 7680x4320');
        }
        await page.setViewportSize({ width, height });
      }
    }
    const info = (await page.evaluate(
      '({ width: innerWidth, height: innerHeight, userAgent: navigator.userAgent, devicePixelRatio })',
    )) as { width: number; height: number; userAgent: string; devicePixelRatio: number };
    return info;
  }

  // ---- Seeing --------------------------------------------------------------------

  /** `patch_browser_screenshot`: the viewport, the whole page, or one element. */
  async screenshot(
    tabId: string,
    opts: { ref?: string; fullPage?: boolean } = {},
  ): Promise<{ data: string; mimeType: string }> {
    await this.agentTurn(tabId);
    const tab = await this.tabFor(tabId);
    let buf: Buffer;
    if (opts.ref) {
      const el = await this.requireLocator(tab, opts.ref);
      buf = await el.screenshot({ type: 'png', scale: 'css' });
    } else {
      buf = await tab.page.screenshot({
        type: 'png',
        // CSS pixels: a live view laying the page out at its own pixel ratio
        // must never change the coordinates the agent reads off a screenshot.
        scale: 'css',
        ...(opts.fullPage ? { fullPage: true } : {}),
      });
    }
    return { data: buf.toString('base64'), mimeType: 'image/png' };
  }

  /** The size of the tab's viewport, i.e. the coordinate space of its screenshots. */
  async viewport(tabId: string): Promise<{ width: number; height: number }> {
    const tab = this.requireTab(tabId);
    const size = tab.page.viewportSize();
    if (size) return size;
    return tab.page.evaluate<{ width: number; height: number }>(
      '({ width: innerWidth, height: innerHeight })',
    );
  }

  /** `patch_browser_click`. */
  /** Same as `click`, without the Computer-use bookkeeping. */
  async clickImpl(tabId: string, ref: string): Promise<void> {
    const tab = await this.tabFor(tabId);
    const locator = await this.requireLocator(tab, ref);
    await this.pointAtLocator(tab, locator);
    await tab.page.waitForTimeout(randomDelay(50, 150));
    await locator.click({ delay: randomDelay(30, 90) });
  }

  /** `patch_browser_type`. */
  /** Same as `type`, without the Computer-use bookkeeping. */
  async typeImpl(
    tabId: string,
    ref: string,
    text: string,
    opts?: { submit?: boolean },
  ): Promise<void> {
    const tab = await this.tabFor(tabId);
    const locator = await this.requireLocator(tab, ref);
    await this.pointAtLocator(tab, locator);
    await tab.page.waitForTimeout(randomDelay(50, 150));
    await locator.click();
    await locator.pressSequentially(text, { delay: randomDelay(40, 120) });
    if (opts?.submit) await locator.press('Enter');
  }

  /** `patch_browser_fill_form`. */
  /** Same as `fillForm`, without the Computer-use bookkeeping. */
  async fillFormImpl(tabId: string, fields: { ref: string; value: string }[]): Promise<void> {
    const tab = await this.tabFor(tabId);
    for (const field of fields) {
      const locator = await this.requireLocator(tab, field.ref);
      await this.pointAtLocator(tab, locator);
      const tag = await locator.evaluate((el) => (el as { tagName: string }).tagName.toLowerCase());
      if (tag === 'select') {
        await locator.selectOption(field.value);
      } else {
        const type = await locator.evaluate((el) => (el as { type?: string }).type ?? '');
        if (type === 'checkbox' || type === 'radio') {
          const want = field.value === 'true' || field.value === 'checked';
          if ((await locator.isChecked()) !== want) await locator.click();
        } else {
          await locator.click();
          await locator.fill('');
          await locator.pressSequentially(field.value, { delay: randomDelay(30, 90) });
        }
      }
      await tab.page.waitForTimeout(randomDelay(50, 120));
    }
  }

  /** `patch_browser_select`. */
  /** Same as `select`, without the Computer-use bookkeeping. */
  async selectImpl(tabId: string, ref: string, value: string): Promise<void> {
    const tab = await this.tabFor(tabId);
    const locator = await this.requireLocator(tab, ref);
    await this.pointAtLocator(tab, locator);
    await locator.selectOption(value);
  }

  /**
   * `patch_browser_upload`. With a `ref`: a file input is filled directly; any
   * other element (a styled "Upload" button) is clicked and the file chooser it
   * opens is filled. Without one: the chooser an earlier click already opened.
   */
  async uploadImpl(tabId: string, filePaths: string[], ref?: string): Promise<void> {
    const tab = await this.tabFor(tabId);
    if (ref) {
      const locator = await this.requireLocator(tab, ref);
      const isFileInput = (await locator.evaluate(
        (el) =>
          (el as { tagName: string; type?: string }).tagName === 'INPUT' &&
          (el as { type?: string }).type === 'file',
      )) as boolean;
      if (isFileInput) {
        await locator.setInputFiles(filePaths);
        return;
      }
      tab.fileChooser = undefined;
      const [chooser] = await Promise.all([
        tab.page.waitForEvent('filechooser', { timeout: 10_000 }),
        locator.click(),
      ]);
      await chooser.setFiles(filePaths);
      tab.fileChooser = undefined;
      return;
    }
    if (!tab.fileChooser) {
      throw new Error(
        'no file chooser is open on this tab: pass the ref of a file input or of the button that opens one',
      );
    }
    const chooser = tab.fileChooser;
    tab.fileChooser = undefined;
    await chooser.setFiles(filePaths);
  }

  /**
   * `patch_browser_mouse`. Real mouse events at screenshot coordinates, for
   * what the ref-based tools cannot reach (canvases, maps, custom widgets,
   * drag and drop, wheel scrolling). Out-of-viewport coordinates fail loudly
   * rather than being clamped onto some other element.
   */
  /** Same as `pointer`, without the Computer-use bookkeeping. */
  async pointerImpl(tabId: string, req: PointerRequest): Promise<void> {
    const tab = await this.tabFor(tabId);
    const { x, y } = req;
    if (x === undefined || y === undefined) {
      throw new Error(`${req.action} needs both x and y (pixels in the screenshot)`);
    }
    const vp = await this.viewport(tabId);
    const inside = (px: number, py: number): boolean =>
      px >= 0 && py >= 0 && px < vp.width && py < vp.height;
    if (!inside(x, y)) {
      throw new Error(
        `(${x}, ${y}) is outside the viewport (${vp.width}x${vp.height}); take a fresh screenshot`,
      );
    }
    const mouse = tab.page.mouse;
    this.markCursor(tab, x, y);
    await mouse.move(x, y, { steps: 8 });
    await tab.page.waitForTimeout(randomDelay(50, 150));
    switch (req.action) {
      case 'move':
        return;
      case 'click':
        await mouse.click(x, y, { delay: randomDelay(30, 90) });
        return;
      case 'double_click':
        await mouse.dblclick(x, y, { delay: randomDelay(30, 90) });
        return;
      case 'right_click':
        await mouse.click(x, y, { button: 'right', delay: randomDelay(30, 90) });
        return;
      case 'drag': {
        const { toX, toY } = req;
        if (toX === undefined || toY === undefined) throw new Error('drag needs toX and toY');
        if (!inside(toX, toY)) {
          throw new Error(
            `(${toX}, ${toY}) is outside the viewport (${vp.width}x${vp.height}); take a fresh screenshot`,
          );
        }
        await mouse.down();
        await mouse.move(toX, toY, { steps: 15 });
        this.markCursor(tab, toX, toY);
        await mouse.up();
        return;
      }
      case 'scroll': {
        const dx = req.scrollX ?? 0;
        const dy = req.scrollY ?? 0;
        if (dx === 0 && dy === 0) throw new Error('scroll needs a non-zero scrollX or scrollY');
        await mouse.wheel(dx, dy);
        return;
      }
    }
  }

  /**
   * `patch_browser_key`. Presses each entry in order into whatever has focus:
   * a key name ("Enter", "Tab", "ArrowDown", "a") or a chord ("Control+a",
   * "Shift+Tab"). Playwright rejects an unknown key name, which surfaces as is.
   */
  /** Same as `pressKeys`, without the Computer-use bookkeeping. */
  async pressKeysImpl(tabId: string, keys: string[]): Promise<void> {
    const tab = await this.tabFor(tabId);
    if (keys.length === 0) throw new Error('press at least one key');
    for (const key of keys) {
      await tab.page.keyboard.press(key, { delay: randomDelay(30, 90) });
      await tab.page.waitForTimeout(randomDelay(30, 90));
    }
  }

  // ---- Live view and hand-off (spec/02 § Browser — Hand-off) --------------

  /** Mark a tab as in the user's hands; every agent tool then refuses it. */
  beginHandoff(tabId: string): void {
    this.requireTab(tabId);
    if (this.handoffTabs.has(tabId)) throw new Error(`tab ${tabId} is already handed over`);
    this.handoffTabs.add(tabId);
  }

  endHandoff(tabId: string): void {
    this.handoffTabs.delete(tabId);
  }

  isHandedOff(tabId: string): boolean {
    return this.handoffTabs.has(tabId);
  }

  /**
   * Every agent call on a tab passes through here. A tab in a hand-off is
   * refused at once; a tab the user has taken over makes the call wait until
   * they hand it back, then fail telling the agent to look again (the page is
   * the user's work now, not what the agent last read), or fail after
   * {@link USER_DRIVE_WAIT_MS} if they never do.
   */
  private async agentTurn(tabId: string): Promise<void> {
    if (this.handoffTabs.has(tabId)) throw new TabInHandoffError(tabId);
    const tab = this.tabsById.get(tabId);
    if (!tab || tab.driver !== 'user') return;
    await new Promise<void>((resolve, reject) => {
      const settle = (outcome: 'handed_back' | 'closed' | 'timeout'): void => {
        clearTimeout(timer);
        const i = tab.driverWaiters.indexOf(waiter);
        if (i >= 0) tab.driverWaiters.splice(i, 1);
        if (outcome === 'handed_back') {
          reject(new UserHandedBackError(tabId, redactUrl(tab.page.url() || tab.lastUrl)));
        } else if (outcome === 'closed') reject(new TabNotFoundError(tabId));
        else reject(new UserDrivingError(tabId));
        void resolve;
      };
      const waiter = (outcome: 'handed_back' | 'closed'): void => settle(outcome);
      const timer = setTimeout(() => settle('timeout'), USER_DRIVE_WAIT_MS);
      timer.unref();
      tab.driverWaiters.push(waiter);
    });
  }

  /** The synchronous form, for reads that answer at once: refuse rather than wait. */
  private assertAgentTurnNow(tabId: string): void {
    if (this.handoffTabs.has(tabId)) throw new TabInHandoffError(tabId);
    if (this.tabsById.get(tabId)?.driver === 'user') throw new UserDrivingError(tabId);
  }

  /** The large view's size the tab is laid out at, if one is. */
  viewerOf(tabId: string): { width: number; height: number; scale: number } | undefined {
    const v = this.tabsById.get(tabId)?.viewer;
    return v ? { width: v.width, height: v.height, scale: v.scale } : undefined;
  }

  /** Who is using the tab now. */
  driverOf(tabId: string): 'agent' | 'user' {
    return this.requireTab(tabId).driver;
  }

  /** The chat that opened the tab, if it is still open. */
  ownerOf(tabId: string): string | undefined {
    return this.tabsById.get(tabId)?.ownerChatId;
  }

  /**
   * Take over (`user`) or Hand back (`agent`). Handing back releases the agent
   * calls that waited, each failing with {@link UserHandedBackError}; with
   * none waiting, the agent hears it on its next read instead.
   */
  setDriver(tabId: string, driver: 'agent' | 'user'): void {
    const tab = this.requireTab(tabId);
    if (tab.driver === driver) return;
    tab.driver = driver;
    if (driver === 'agent') {
      const waiters = tab.driverWaiters.splice(0);
      if (waiters.length === 0) {
        tab.notices.push(
          `the user used this tab and handed it back at ${redactUrl(tab.page.url() || tab.lastUrl)}; it may have changed since you last read it`,
        );
      }
      for (const w of waiters) w('handed_back');
    }
    this.notify(tab.ownerChatId);
  }

  /** Where the agent is pointing, for the live view's cursor. */
  private markCursor(tab: Tab, x: number, y: number): void {
    tab.cursor = { x: Math.round(x), y: Math.round(y), at: Date.now() };
    this.notify(tab.ownerChatId);
  }

  /** The centre of an element the agent is about to act on, as its cursor. */
  private async pointAtLocator(tab: Tab, locator: Locator): Promise<void> {
    const box = await locator.boundingBox().catch(() => null);
    if (box) this.markCursor(tab, box.x + box.width / 2, box.y + box.height / 2);
  }

  /** The tab this chat opened most recently and that is still open. */
  latestTabOwnedBy(chatId: string): string | undefined {
    let found: string | undefined;
    for (const tab of this.tabsById.values()) if (tab.ownerChatId === chatId) found = tab.tabId;
    return found;
  }

  /** The tab's address without query or fragment; '' once the tab is gone. */
  redactedUrl(tabId: string): string {
    const tab = this.tabsById.get(tabId);
    return tab ? redactUrl(tab.page.url()) : '';
  }

  /**
   * The tab's live picture for the user's view: Chrome's screencast pushes a
   * JPEG each time the page paints, so the view moves as the page does, and a
   * still picture is sent at once so a page that is not moving still shows. A
   * frame is acknowledged (and so the next one released) no sooner than
   * `minFrameMs` after the last, which caps the rate a busy page sends.
   * While a large view lays the tab out at a higher pixel ratio, Chrome's
   * screencast still draws at the window's own ratio, so it serves only as
   * the signal that the page painted: each paint is answered with a screenshot
   * from the session that set the ratio, which is drawn at it. `onEnd` fires
   * once if the page closes. Never reaches the model.
   */
  async screencast(
    tabId: string,
    onFrame: (f: ScreencastFrame) => void,
    onEnd: () => void,
    opts: { quality?: number; minFrameMs?: number } = {},
  ): Promise<Screencast> {
    const tab = await this.tabFor(tabId);
    const page = tab.page;
    const cdp = await page.context().newCDPSession(page);
    const minFrameMs = opts.minFrameMs ?? 50;
    const quality = opts.quality ?? 85;
    let title = await page.title().catch(() => '');
    const history = { canGoBack: false, canGoForward: false };
    let stopped = false;
    let lastFrameAt = 0;
    let capturing = false;
    let dirty = false;
    const refreshTitle = (): void => {
      void page
        .title()
        .then((t) => (title = t))
        .catch(() => undefined);
    };
    const refreshHistory = async (): Promise<void> => {
      const h = (await cdp.send('Page.getNavigationHistory').catch(() => null)) as {
        currentIndex: number;
        entries: unknown[];
      } | null;
      if (!h) return;
      history.canGoBack = h.currentIndex > 0;
      history.canGoForward = h.currentIndex < h.entries.length - 1;
    };
    const onNavigated = (frame: Frame): void => {
      refreshTitle();
      if (frame === page.mainFrame()) void refreshHistory();
    };
    const ended = (): void => {
      if (stopped) return;
      stopped = true;
      onEnd();
    };
    const emit = (data: string, width: number, height: number): void => {
      onFrame({
        data,
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
        url: redactUrl(page.url()),
        title,
        ...history,
      });
    };
    /** One sharp picture per paint at a large view's ratio; paints that land meanwhile share the next. */
    const sharp = async (): Promise<void> => {
      if (capturing) {
        dirty = true;
        return;
      }
      capturing = true;
      // Chrome refuses a capture for a moment after the size changes; a page
      // that is not moving will not paint again to ask, so try again here.
      let misses = 0;
      try {
        do {
          dirty = false;
          const v = tab.viewer;
          const session = tab.cdp;
          if (!v || !session || stopped || tab.page !== page) break;
          const shot = (await session
            .send('Page.captureScreenshot', { format: 'jpeg', quality })
            .catch(() => null)) as { data: string } | null;
          // The view closed or resized while the capture ran: this picture is the old size,
          // and a still page never paints again to replace it.
          if (shot && !stopped && tab.viewer === v) emit(shot.data, v.width, v.height);
          else if (!shot && ++misses < 30) dirty = true;
          await new Promise((r) => setTimeout(r, shot ? minFrameMs : 100));
        } while (dirty && !stopped);
      } finally {
        capturing = false;
      }
    };
    const sharpWanted = (): boolean =>
      tab.page === page && tab.cdp !== undefined && (tab.viewer?.scale ?? 1) > 1;
    page.on('load', refreshTitle);
    page.on('framenavigated', onNavigated);
    page.on('close', ended);
    cdp.on(
      'Page.screencastFrame',
      (f: {
        data: string;
        sessionId: number;
        metadata: { deviceWidth: number; deviceHeight: number };
      }) => {
        if (stopped) return;
        if (sharpWanted()) void sharp();
        else emit(f.data, f.metadata.deviceWidth, f.metadata.deviceHeight);
        const wait = Math.max(0, lastFrameAt + minFrameMs - Date.now());
        lastFrameAt = Date.now() + wait;
        setTimeout(() => {
          if (!stopped)
            void cdp
              .send('Page.screencastFrameAck', { sessionId: f.sessionId })
              .catch(() => undefined);
        }, wait).unref();
      },
    );
    /** Chrome sends a frame only when the page paints: a still page would show nothing. */
    const still = async (): Promise<void> => {
      if (sharpWanted()) return sharp();
      // Chrome refuses a capture for a moment after the page changes size, and a
      // page that is not moving will not paint again to ask: try for a while.
      for (let attempt = 0; attempt < 30 && !stopped; attempt++) {
        const m = (await cdp.send('Page.getLayoutMetrics').catch(() => null)) as {
          cssVisualViewport?: { clientWidth: number; clientHeight: number };
        } | null;
        const shot = (await cdp
          .send('Page.captureScreenshot', { format: 'jpeg', quality })
          .catch(() => null)) as { data: string } | null;
        if (shot && m?.cssVisualViewport) {
          if (!stopped) {
            emit(shot.data, m.cssVisualViewport.clientWidth, m.cssVisualViewport.clientHeight);
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const start = async (): Promise<void> => {
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality, everyNthFrame: 1 });
      await still();
    };
    await refreshHistory();
    await start();
    return {
      refresh: async () => {
        if (!stopped) await still();
      },
      stop: async () => {
        stopped = true;
        page.off('load', refreshTitle);
        page.off('framenavigated', onNavigated);
        page.off('close', ended);
        await cdp.send('Page.stopScreencast').catch(() => undefined);
        await cdp.detach().catch(() => undefined);
      },
    };
  }

  /**
   * A large live view's size laid over the agent's: the page is laid out at
   * the view's CSS size and drawn at its pixel ratio, so the picture is as
   * sharp as the screen it lands on and the page takes the shape of that
   * screen (a phone gets the site's narrow layout). `null` puts the agent's
   * own size back. A device the agent emulated, or a size the agent set since,
   * is never overridden.
   */
  setViewerViewport(
    tabId: string,
    vp: { width: number; height: number; scale: number } | null,
  ): Promise<void> {
    // One at a time per tab: a renewal landing while a restore is half done
    // would read the view's size back as the agent's and never give it back.
    const prev = this.viewerChains.get(tabId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.applyViewerViewport(tabId, vp));
    this.viewerChains.set(tabId, next);
    void next.finally(() => {
      if (this.viewerChains.get(tabId) === next) this.viewerChains.delete(tabId);
    });
    return next;
  }

  private readonly viewerChains = new Map<string, Promise<void>>();

  private async applyViewerViewport(
    tabId: string,
    vp: { width: number; height: number; scale: number } | null,
  ): Promise<void> {
    const tab = this.tabsById.get(tabId);
    if (!tab) return;
    if (tab.page.isClosed()) return;
    if (vp === null) {
      tab.viewerYielded = false;
      if (!tab.viewer) return;
      const { saved } = tab.viewer;
      tab.viewer = undefined;
      if (tab.cdp) await tab.cdp.send('Emulation.clearDeviceMetricsOverride');
      await tab.page.setViewportSize(saved);
      // Chrome applies the cleared view override a moment late, which can leave the page laid
      // out at the view's size while Playwright believes the agent's size is back on; nudge
      // the size until the page really takes it.
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 150));
        const width = await tab.page.evaluate('innerWidth').catch(() => saved.width);
        if (width === saved.width) break;
        await tab.page.setViewportSize({ width: saved.width + 1, height: saved.height });
        await tab.page.setViewportSize(saved);
        await new Promise((r) => setTimeout(r, 100));
      }
      return;
    }
    if (tab.agentDevice || tab.viewerYielded) return;
    const clamp = (n: number, lo: number, hi: number): number =>
      Math.min(hi, Math.max(lo, Math.round(n)));
    const width = clamp(vp.width, VIEWER_MIN.width, VIEWER_MAX.width);
    const height = clamp(vp.height, VIEWER_MIN.height, VIEWER_MAX.height);
    const scale = Math.min(3, Math.max(1, vp.scale));
    const v = tab.viewer;
    if (v && v.width === width && v.height === height && v.scale === scale) return;
    if (!tab.cdp) tab.cdp = await tab.page.context().newCDPSession(tab.page);
    const saved = v ? v.saved : await this.viewport(tabId);
    // The tab takes the view's size, so the agent's screenshots and the view
    // agree; the ratio rides only on this session, so a screenshot the agent
    // takes stays in CSS pixels while the view's captures here are sharp.
    await tab.page.setViewportSize({ width, height });
    await tab.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    tab.viewer = { width, height, scale, saved };
  }

  /**
   * The user's input from the live view, at any time (`patch.browser_view.input`):
   * presses and releases with their button and modifiers, so a drag selects or
   * drags; held keys; the toolbar's navigation; copying the selection out
   * (returns it); and the sign-in card's values. Not an agent action: no
   * Computer-use gate, no `running` entry, no human timing. Text and values are
   * never logged, and a field the user typed into reads as `[redacted]` to the agent.
   */
  async viewInput(tabId: string, input: ViewUserInput): Promise<string | undefined> {
    const tab = this.requireTab(tabId);
    const page = tab.page;
    const markTyped = (): Promise<unknown> =>
      page.evaluate(
        `document.activeElement && document.activeElement.setAttribute('data-patch-user-typed', '')`,
      );
    switch (input.kind) {
      case 'pointer': {
        const held = (input.modifiers ?? []).map((m) => this.hostModifier(m));
        for (const m of held) await page.keyboard.down(m);
        try {
          const { x, y } = input;
          const button = input.button ?? 'left';
          const clickCount = input.clickCount ?? 1;
          await page.mouse.move(x, y);
          if (input.action === 'down') await page.mouse.down({ button, clickCount });
          else if (input.action === 'up') await page.mouse.up({ button, clickCount });
          else if (input.action === 'click') await page.mouse.click(x, y, { button, clickCount });
          else if (input.action === 'double_click') await page.mouse.dblclick(x, y, { button });
          else if (input.action === 'right_click') {
            await page.mouse.click(x, y, { button: 'right' });
          }
        } finally {
          for (const m of held.reverse()) await page.keyboard.up(m);
        }
        return undefined;
      }
      case 'scroll':
        await page.mouse.move(input.x, input.y);
        await page.mouse.wheel(input.dx, input.dy);
        return undefined;
      case 'text':
        await page.keyboard.insertText(input.text);
        await markTyped();
        return undefined;
      case 'key': {
        const key = this.hostChord(input.key);
        if (input.action === 'down') await page.keyboard.down(key);
        else if (input.action === 'up') await page.keyboard.up(key);
        else await page.keyboard.press(key);
        return undefined;
      }
      case 'nav':
        // `commit`: the toolbar answers as the page starts to change, not when it finishes.
        if (input.action === 'back') await page.goBack({ waitUntil: 'commit' });
        else if (input.action === 'forward') await page.goForward({ waitUntil: 'commit' });
        else if (input.action === 'reload') await page.reload({ waitUntil: 'commit' });
        else {
          if (!input.url) throw new Error('goto needs an address');
          await page.goto(addressToUrl(input.url), { waitUntil: 'commit' });
        }
        return undefined;
      case 'copy':
        return String(await page.evaluate(SELECTION_SCRIPT));
      case 'fill': {
        const current = await this.detectForm(tabId);
        if (!current || current.formId !== input.formId) {
          throw new Error('the sign-in form changed before it could be filled; fill it again');
        }
        let last: Locator | undefined;
        for (const { field, value } of input.values) {
          const el = page.locator(`[data-patch-field="${field}"]`).first();
          await el.fill(value);
          await el.evaluate((node) =>
            (node as { setAttribute(n: string, v: string): void }).setAttribute(
              'data-patch-user-typed',
              '',
            ),
          );
          last = el;
        }
        if (input.submit && last) await last.press('Enter');
        return undefined;
      }
    }
  }

  /**
   * The visible sign-in form on the tab, if it has one: its fields' labels and
   * kinds, tagged so `viewInput` `fill` can reach them. `formId` changes when
   * the form does (a password step after an email step).
   */
  async detectForm(tabId: string): Promise<DetectedForm | null> {
    const tab = this.requireTab(tabId);
    if (tab.page.isClosed()) return null;
    const fields = (await tab.page
      .evaluate(DETECT_FORM_SCRIPT)
      .catch(() => [])) as DetectedForm['fields'];
    if (fields.length === 0) return null;
    let site = '';
    let path = '';
    try {
      const u = new URL(tab.page.url());
      site = u.hostname.replace(/^www\./, '');
      path = u.pathname;
    } catch {
      /* about:blank and the like have no site */
    }
    const formId = createHash('sha256')
      .update(JSON.stringify([site, path, fields]))
      .digest('hex')
      .slice(0, 16);
    return { formId, site, fields };
  }

  /** Cmd on the user's Mac is Ctrl to a browser on any other system. */
  private hostModifier(m: 'Alt' | 'Control' | 'Meta' | 'Shift'): string {
    return m === 'Meta' && process.platform !== 'darwin' ? 'Control' : m;
  }

  private hostChord(key: string): string {
    return process.platform === 'darwin' ? key : key.replace(/(^|\+)Meta(?=\+)/g, '$1Control');
  }

  /**
   * The user's own input, as real browser events at viewport coordinates.
   * Not an agent action: no Computer-use gate, no `running` entry, no human
   * timing. The text is never logged.
   */
  async userInput(tabId: string, input: HandoffUserInput): Promise<void> {
    const tab = this.requireTab(tabId);
    switch (input.kind) {
      case 'pointer': {
        const { x, y } = input;
        await tab.page.mouse.move(x, y);
        if (input.action === 'click') await tab.page.mouse.click(x, y);
        else if (input.action === 'double_click') await tab.page.mouse.dblclick(x, y);
        else if (input.action === 'right_click')
          await tab.page.mouse.click(x, y, { button: 'right' });
        return;
      }
      case 'scroll':
        await tab.page.mouse.move(input.x, input.y);
        await tab.page.mouse.wheel(input.dx, input.dy);
        return;
      case 'text':
        await tab.page.keyboard.insertText(input.text);
        // Remember whose text sits in this field, so a later read of the tab redacts it.
        await tab.page.evaluate(
          `document.activeElement && document.activeElement.setAttribute('data-patch-user-typed', '')`,
        );
        return;
      case 'key':
        await tab.page.keyboard.press(input.key);
        return;
    }
  }

  /**
   * OAuth loopback relay. While active, a navigation of this tab to
   * `http(s)://localhost|127.0.0.1:<port>/…` is fetched by THIS process from
   * its own loopback and the answer handed back to the page, so the waiting
   * listener receives the authorization code even though the page that
   * carried it may be anywhere. The URL (code included) goes nowhere else.
   * Resolves `delivered` with the listener's HTTP status; rejects if the
   * listener cannot be reached. Returns a disposer.
   */
  async relayLoopback(
    tabId: string,
    port: number,
  ): Promise<{ delivered: Promise<{ status: number }>; dispose: () => Promise<void> }> {
    const tab = this.requireTab(tabId);
    const pattern = new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${port}(/|\\?|$)`);
    let settle!: { resolve: (v: { status: number }) => void; reject: (e: Error) => void };
    const delivered = new Promise<{ status: number }>((resolve, reject) => {
      settle = { resolve, reject };
    });
    delivered.catch(() => undefined);
    await tab.page.route(pattern, async (route) => {
      const target = new URL(route.request().url());
      try {
        const res = await fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, {
          redirect: 'manual',
        });
        const body = await res.text();
        await route.fulfill({
          status: res.status,
          contentType: res.headers.get('content-type') ?? 'text/plain',
          body,
        });
        settle.resolve({ status: res.status });
      } catch (err) {
        const message = `the waiting process on port ${port} could not be reached: ${err instanceof Error ? err.message : String(err)}`;
        await route.abort().catch(() => undefined);
        settle.reject(new Error(message));
      }
    });
    return {
      delivered,
      dispose: async () => {
        await tab.page.unroute(pattern).catch(() => undefined);
      },
    };
  }

  /** `patch_browser_tabs`. */
  async tabs(): Promise<TabInfo[]> {
    this.pruneClosedTabs();
    const out: TabInfo[] = [];
    for (const tab of this.tabsById.values()) {
      const handedOff = this.handoffTabs.has(tab.tabId);
      const alive = !tab.page.isClosed() && !tab.crashed;
      const url = alive ? tab.page.url() : tab.lastUrl;
      out.push({
        tabId: tab.tabId,
        title: handedOff || !alive ? '' : await tab.page.title().catch(() => ''),
        url: handedOff ? redactUrl(url) : url,
        profile: tab.profile,
        ...(tab.openerTabId ? { openerTabId: tab.openerTabId } : {}),
        ...(tab.tabId === this.activeTabId ? { active: true } : {}),
        ...(tab.routedVia ? { routedVia: tab.routedVia } : {}),
      });
    }
    return out;
  }

  /** `patch_browser_close`. */
  async close(tabId: string): Promise<void> {
    const tab = this.requireTab(tabId);
    this.tabsById.delete(tabId);
    this.handoffTabs.delete(tabId);
    if (this.activeTabId === tabId) this.activeTabId = undefined;
    for (const w of tab.driverWaiters.splice(0)) w('closed');
    try {
      if (!tab.page.isClosed()) await tab.page.close();
      if (tab.ephemeralContext) await tab.ephemeralContext.close();
    } finally {
      this.notify(tab.ownerChatId);
    }
  }

  /**
   * Close every page opened by one chat.
   *
   * A browser page is work owned by the turn/chat that opened it, not a
   * daemon-global resource.  The persistent profile remains alive (and keeps
   * its cookies); only pages which otherwise retain renderer processes after
   * the owning chat has stopped working are released.
   */
  async closeOwnedByChat(chatId: string): Promise<void> {
    const owned = [...this.tabsById]
      .filter(([, tab]) => tab.ownerChatId === chatId)
      .map(([tabId]) => tabId);
    for (const tabId of owned) {
      await this.close(tabId).catch((err: unknown) => {
        this.opts.logger.warn({ chatId, tabId, err }, 'browser: error closing chat-owned tab');
      });
    }
  }

  /**
   * Wipe the shared 'logged-in' profile — every saved session on this host,
   * gone. Groundwork for Settings → Hosts → Browser → "clear all" (a later
   * step); not wired to a tool yet.
   */
  async clearLoggedInProfile(): Promise<void> {
    await this.closeTabsFor('logged-in');
    if (this.usingApp()) {
      // The profile is the app's: clear what it holds rather than a directory here.
      const context = await this.getLoggedInContext();
      await context.clearCookies();
      return;
    }
    if (this.loggedInContext) {
      await this.loggedInContext.close();
      this.loggedInContext = null;
    }
    rmSync(join(this.opts.root, 'profile'), { recursive: true, force: true });
  }

  /** Close every tab/context/browser and stop this manager's own Xvfb. */
  async dispose(): Promise<void> {
    this.disposing = true;
    for (const tabId of [...this.tabsById.keys()]) {
      await this.close(tabId).catch((err: unknown) => {
        this.opts.logger.warn({ tabId, err }, 'browser: error closing tab on dispose');
      });
    }
    if (this.appConnection) {
      // Closes what this host opened in the app; the app itself keeps running.
      const app = this.appConnection;
      this.appConnection = null;
      this.loggedInContext = null;
      this.ephemeralBrowser = null;
      await app.close().catch(() => undefined);
    }
    if (this.loggedInContext) {
      await this.loggedInContext.close().catch(() => undefined);
      this.loggedInContext = null;
      this.loggedInContextProxyKey = null;
    }
    if (this.ephemeralBrowser) {
      await this.ephemeralBrowser.close().catch(() => undefined);
      this.ephemeralBrowser = null;
      this.ephemeralBrowserProxyKey = null;
    }
    if (this.xvfb) {
      this.xvfb.kill();
      this.xvfb = null;
    }
  }
}
