// The agent's browser, inside the Patch app (spec/02 § Browser — In the Patch
// app). When a host runs on the same machine as this app, the agent's tabs are
// real browser tabs here — WebContentsViews — so the large view is the page
// itself, not a picture of it: typing, selection, the context menu, scrolling
// and copy and paste are the browser's own. The host still drives them with the
// same Playwright code as everywhere else, over the DevTools protocol, so every
// patch_browser_* tool works unchanged.
//
// Electron has no browser-wide DevTools endpoint a process may reach without
// opening an unauthenticated port, so this module IS that endpoint: a
// loopback WebSocket at a path holding a random token, written to a mode-600
// file only this user can read. Page sessions are relayed to each tab's
// `webContents.debugger`; the few browser-level commands Playwright sends
// (targets, contexts, cookies, permissions, downloads) are answered from
// Electron's own APIs (agent-browser-cdp.ts translates the shapes).
//
// Tabs live in a hidden window until a large view shows one, when it moves into
// that window at the view's place, and back when the view closes. The
// signed-in profile is this app's own persistent partition; each throwaway
// context the host asks for is an in-memory partition of its own.
//
// NO FALLBACK: a command this bridge does not answer fails with its name, so
// the host's tool fails saying what was missing rather than half-working.

import {
  BrowserWindow,
  Menu,
  WebContentsView,
  app,
  clipboard,
  session as electronSession,
  shell,
  type DownloadItem,
  type Session,
  type WebContents,
} from 'electron';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildContextMenuTemplate } from './context-menu';
import {
  cookieFromCdp,
  cookieToCdp,
  cookieUrl,
  downloadState,
  permissionGranted,
  type AgentBrowserEndpoint,
  type CdpCookieParam,
} from './agent-browser-cdp';

import { stripAppTokens } from './agent-user-agent';

/** The agent's signed-in profile: kept across restarts, shared by every chat. */
export const AGENT_PROFILE_PARTITION = 'persist:patch-agent-browser';
/** Where a tab is laid out while no view shows it. */
const HIDDEN_SIZE = { width: 1280, height: 800 };

interface AgentContext {
  id: string;
  ses: Session;
  grants: { origin: string | undefined; permissions: string[] }[];
  temporary: boolean;
}

interface Target {
  targetId: string;
  sessionId: string;
  view: WebContentsView;
  wc: WebContents;
  context: AgentContext;
  openerId?: string;
  /** The window a large view shows it in; null while hidden. */
  shownIn: BrowserWindow | null;
  bounds: { x: number; y: number; width: number; height: number };
}

interface Message {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface AgentBrowserOptions {
  /** `<home>/.patch/agent-browser.json`. */
  endpointFile: string;
  /** What the host starts when this app is not running; absent for an unpackaged dev run. */
  appPath?: string;
  version: string;
  log: (message: string, extra?: unknown) => void;
  /** The user pressed or typed in a tab a large view is showing. */
  onUserInput: (win: BrowserWindow, targetId: string) => void;
}

export class AgentBrowser {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private holder: BrowserWindow | null = null;
  private readonly contexts = new Map<string, AgentContext>();
  private readonly targets = new Map<string, Target>();
  /** Every page session id the client may address: a tab's own, or a child or second session on it. */
  private readonly sessions = new Map<string, { target: Target; child?: string }>();
  /** Sessions that speak to the browser itself (`Target.attachToBrowserTarget`). */
  private readonly browserSessions = new Set<string>();
  private readonly downloads = new Map<string, DownloadItem>();
  private downloadBehavior: { behavior: string; path?: string; events: boolean } = {
    behavior: 'deny',
    events: false,
  };
  private autoAttach = false;
  private seq = 0;

  constructor(private readonly opts: AgentBrowserOptions) {}

  async start(): Promise<void> {
    const token = randomBytes(32).toString('hex');
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      path: `/devtools/browser/${token}`,
      maxPayload: 256 * 1024 * 1024,
    });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    this.wss = wss;
    wss.on('connection', (ws) => this.accept(ws));
    const { port } = wss.address() as { port: number };
    this.writeEndpoint(`ws://127.0.0.1:${port}/devtools/browser/${token}`);
  }

  /** Close every tab and the endpoint; the file still says how to start this app. */
  async stop(): Promise<void> {
    this.writeEndpoint(undefined);
    for (const t of [...this.targets.values()]) this.closeTarget(t);
    this.client?.close();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    this.wss = null;
    this.holder?.destroy();
    this.holder = null;
  }

  owns(targetId: string): boolean {
    return this.targets.has(targetId);
  }

  /** Show a tab in `win` at `rect` (window content coordinates), for a large view. */
  show(
    targetId: string,
    win: BrowserWindow,
    rect: { x: number; y: number; width: number; height: number },
  ): boolean {
    const t = this.targets.get(targetId);
    if (!t || win.isDestroyed()) return false;
    const bounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
    if (t.shownIn !== win) {
      this.detachView(t);
      win.contentView.addChildView(t.view);
      t.shownIn = win;
      this.watchWindow(win);
    }
    t.view.setBounds(bounds);
    t.bounds = bounds;
    return true;
  }

  /** Put a shown tab back in the hidden window, at the size it last had. */
  hide(targetId: string): void {
    const t = this.targets.get(targetId);
    if (!t || !t.shownIn) return;
    this.detachView(t);
    t.shownIn = null;
    this.ensureHolder().contentView.addChildView(t.view);
    t.view.setBounds({ x: 0, y: 0, width: t.bounds.width, height: t.bounds.height });
  }

  private readonly watchedWindows = new WeakSet<BrowserWindow>();

  /**
   * A window that closes, or whose page reloads, gives its tabs back to the
   * hidden window: closing must not take the agent's tabs with it, and a
   * reloaded page has no view left for a tab to sit over.
   */
  private watchWindow(win: BrowserWindow): void {
    if (this.watchedWindows.has(win)) return;
    this.watchedWindows.add(win);
    const giveBack = (): void => {
      for (const t of this.targets.values()) if (t.shownIn === win) this.hide(t.targetId);
    };
    win.on('close', giveBack);
    win.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) giveBack();
    });
    win.webContents.on('render-process-gone', giveBack);
  }

  // ---- The endpoint -----------------------------------------------------------

  private writeEndpoint(endpoint: string | undefined): void {
    const file = this.opts.endpointFile;
    const body: AgentBrowserEndpoint = {
      ...(endpoint ? { endpoint, pid: process.pid } : {}),
      ...(this.opts.appPath ? { appPath: this.opts.appPath } : {}),
      version: this.opts.version,
    };
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    renameSync(tmp, file);
  }

  private accept(ws: WebSocket): void {
    // One host drives this browser. A new connection is that host again (it
    // restarted): what the old one opened goes, as a browser's tabs go with it.
    if (this.client) {
      this.client.close();
      this.reset();
    }
    this.client = ws;
    ws.on('message', (raw) => void this.receive(raw));
    ws.on('close', () => {
      if (this.client !== ws) return;
      this.client = null;
      this.reset();
    });
  }

  private reset(): void {
    for (const t of [...this.targets.values()]) this.closeTarget(t);
    for (const c of [...this.contexts.values()]) if (c.temporary) this.contexts.delete(c.id);
    this.browserSessions.clear();
    this.autoAttach = false;
    this.downloadBehavior = { behavior: 'deny', events: false };
  }

  private send(m: Record<string, unknown>): void {
    if (this.client?.readyState === this.client?.OPEN) this.client?.send(JSON.stringify(m));
  }

  private async receive(raw: RawData): Promise<void> {
    let msg: Message;
    try {
      msg = JSON.parse(String(raw)) as Message;
    } catch {
      return;
    }
    const { id, method, sessionId } = msg;
    const params = msg.params ?? {};
    const reply = (result: unknown): void =>
      this.send({ id, result: result ?? {}, ...(sessionId ? { sessionId } : {}) });
    const fail = (message: string): void =>
      this.send({ id, error: { code: -32000, message }, ...(sessionId ? { sessionId } : {}) });
    try {
      if (sessionId && !this.browserSessions.has(sessionId)) {
        const s = this.sessions.get(sessionId);
        if (!s) return fail(`no session ${sessionId}`);
        // A tab here is never paused waiting for a debugger.
        if (method === 'Runtime.runIfWaitingForDebugger' && !s.child) return reply({});
        const result: unknown = await s.target.wc.debugger.sendCommand(method, params, s.child);
        return reply(result);
      }
      return reply(await this.browserCommand(method, params));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  // ---- Browser-level commands -------------------------------------------------

  private async browserCommand(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: `Chrome/${process.versions.chrome}`,
          revision: '',
          userAgent: this.context('default').ses.getUserAgent(),
          jsVersion: process.versions.v8,
        };
      case 'Browser.close':
        // The app is not the agent's to quit: what it opened closes.
        for (const t of [...this.targets.values()]) this.closeTarget(t);
        return {};
      case 'Browser.getWindowForTarget': {
        const holder = this.ensureHolder();
        return {
          windowId: holder.id,
          bounds: { left: 0, top: 0, ...HIDDEN_SIZE, windowState: 'normal' },
        };
      }
      case 'Browser.setDownloadBehavior':
        this.downloadBehavior = {
          behavior: String(params['behavior'] ?? 'deny'),
          ...(typeof params['downloadPath'] === 'string' ? { path: params['downloadPath'] } : {}),
          events: params['eventsEnabled'] === true,
        };
        return {};
      case 'Browser.cancelDownload': {
        this.downloads.get(String(params['guid']))?.cancel();
        return {};
      }
      case 'Browser.grantPermissions': {
        const ctx = this.context(params['browserContextId']);
        ctx.grants.push({
          origin: typeof params['origin'] === 'string' ? params['origin'] : undefined,
          permissions: (params['permissions'] as string[] | undefined) ?? [],
        });
        return {};
      }
      case 'Browser.resetPermissions':
        this.context(params['browserContextId']).grants = [];
        return {};
      case 'Target.setAutoAttach':
        this.autoAttach = params['autoAttach'] === true;
        if (this.autoAttach) for (const t of this.targets.values()) this.announceAttached(t);
        return {};
      case 'Target.setDiscoverTargets':
        return {};
      case 'Target.getTargetInfo': {
        const t =
          typeof params['targetId'] === 'string' ? this.targets.get(params['targetId']) : undefined;
        if (t) return { targetInfo: this.info(t) };
        return {
          targetInfo: {
            targetId: 'browser',
            type: 'browser',
            title: '',
            url: '',
            attached: true,
            canAccessOpener: false,
          },
        };
      }
      case 'Target.getTargets':
        return { targetInfos: [...this.targets.values()].map((t) => this.info(t)) };
      case 'Target.getBrowserContexts':
        return {
          browserContextIds: [...this.contexts.values()]
            .filter((c) => c.temporary)
            .map((c) => c.id),
        };
      case 'Target.createBrowserContext': {
        const id = randomUUID().replace(/-/g, '').toUpperCase();
        // No `persist:` prefix: an in-memory profile, gone with the context.
        const ses = electronSession.fromPartition(`agent-temp-${id}`);
        const ctx = this.prepareContext(id, ses, true);
        if (typeof params['proxyServer'] === 'string') {
          await ses.setProxy({
            proxyRules: params['proxyServer'],
            ...(typeof params['proxyBypassList'] === 'string'
              ? { proxyBypassRules: params['proxyBypassList'] }
              : {}),
          });
        }
        return { browserContextId: ctx.id };
      }
      case 'Target.disposeBrowserContext': {
        const ctx = this.contexts.get(String(params['browserContextId']));
        if (!ctx || !ctx.temporary) throw new Error('no such browser context');
        for (const t of [...this.targets.values()]) if (t.context === ctx) this.closeTarget(t);
        await ctx.ses.clearStorageData();
        this.contexts.delete(ctx.id);
        return {};
      }
      case 'Target.createTarget': {
        const t = await this.createTarget(
          this.context(params['browserContextId']),
          typeof params['url'] === 'string' ? params['url'] : 'about:blank',
        );
        return { targetId: t.targetId };
      }
      case 'Target.closeTarget': {
        const t = this.targets.get(String(params['targetId']));
        if (!t) throw new Error(`no target ${String(params['targetId'])}`);
        this.closeTarget(t);
        return { success: true };
      }
      case 'Target.attachToBrowserTarget': {
        const id = `B${++this.seq}`;
        this.browserSessions.add(id);
        return { sessionId: id };
      }
      case 'Target.attachToTarget': {
        // A second client session on a tab: a real DevTools session to itself.
        const t = this.targets.get(String(params['targetId']));
        if (!t) throw new Error(`no target ${String(params['targetId'])}`);
        const { sessionId } = (await t.wc.debugger.sendCommand('Target.attachToTarget', {
          targetId: t.targetId,
          flatten: true,
        })) as { sessionId: string };
        this.sessions.set(sessionId, { target: t, child: sessionId });
        return { sessionId };
      }
      case 'Target.detachFromTarget': {
        const id = String(params['sessionId']);
        if (this.browserSessions.delete(id)) return {};
        const s = this.sessions.get(id);
        if (s?.child) {
          await s.target.wc.debugger.sendCommand('Target.detachFromTarget', { sessionId: s.child });
          this.sessions.delete(id);
        }
        return {};
      }
      case 'Storage.getCookies': {
        const cookies = await this.context(params['browserContextId']).ses.cookies.get({});
        return { cookies: cookies.map(cookieToCdp) };
      }
      case 'Storage.setCookies': {
        const ses = this.context(params['browserContextId']).ses;
        for (const c of (params['cookies'] as CdpCookieParam[] | undefined) ?? []) {
          await ses.cookies.set(cookieFromCdp(c));
        }
        return {};
      }
      case 'Storage.clearCookies': {
        const ses = this.context(params['browserContextId']).ses;
        for (const c of await ses.cookies.get({})) await ses.cookies.remove(cookieUrl(c), c.name);
        return {};
      }
      default:
        throw new Error(`the Patch app's browser does not support ${method}`);
    }
  }

  // ---- Contexts and tabs ------------------------------------------------------

  private context(id: unknown): AgentContext {
    const key = typeof id === 'string' && id !== '' ? id : 'default';
    const found = this.contexts.get(key);
    if (found) return found;
    if (key !== 'default') throw new Error(`no browser context ${key}`);
    return this.prepareContext(
      'default',
      electronSession.fromPartition(AGENT_PROFILE_PARTITION),
      false,
    );
  }

  private prepareContext(id: string, ses: Session, temporary: boolean): AgentContext {
    const ctx: AgentContext = { id, ses, grants: [], temporary };
    this.contexts.set(id, ctx);
    // A normal Chrome: no app or Electron token in what sites see.
    ses.setUserAgent(stripAppTokens(ses.getUserAgent()));
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const origin = safeOrigin(details.requestingUrl ?? wc?.getURL() ?? '');
      callback(permissionGranted(ctx.grants, origin, permission));
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
      permissionGranted(ctx.grants, requestingOrigin, permission),
    );
    ses.on('will-download', (_e, item, wc) => this.download(item, wc));
    return ctx;
  }

  private download(item: DownloadItem, wc: WebContents): void {
    const { behavior, path, events } = this.downloadBehavior;
    if ((behavior !== 'allow' && behavior !== 'allowAndName') || !path) {
      item.cancel();
      return;
    }
    const guid = randomUUID();
    this.downloads.set(guid, item);
    item.setSavePath(join(path, behavior === 'allowAndName' ? guid : item.getFilename()));
    const frameId = [...this.targets.values()].find((t) => t.wc === wc)?.targetId ?? '';
    if (events) {
      this.send({
        method: 'Browser.downloadWillBegin',
        params: { frameId, guid, url: item.getURL(), suggestedFilename: item.getFilename() },
      });
    }
    const progress = (state: Parameters<typeof downloadState>[0]): void => {
      if (!events) return;
      this.send({
        method: 'Browser.downloadProgress',
        params: {
          guid,
          totalBytes: item.getTotalBytes(),
          receivedBytes: item.getReceivedBytes(),
          state: downloadState(state),
        },
      });
    };
    item.on('updated', (_e, state) => progress(state === 'interrupted' ? 'progressing' : state));
    item.once('done', (_e, state) => {
      progress(state);
      this.downloads.delete(guid);
    });
  }

  private ensureHolder(): BrowserWindow {
    if (this.holder && !this.holder.isDestroyed()) return this.holder;
    // Open but never seen: a hidden window's pages make no frames, so the
    // agent's screenshots and the live view of a tab no view shows would wait
    // forever. Borderless, transparent, off every screen, taking no clicks and
    // no focus (the app also ignores occlusion, see main.ts).
    const holder = new BrowserWindow({
      show: false,
      x: -32000,
      y: -32000,
      ...HIDDEN_SIZE,
      frame: false,
      transparent: true,
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      webPreferences: { backgroundThrottling: false },
    });
    holder.setOpacity(0);
    holder.setIgnoreMouseEvents(true);
    if (process.platform === 'darwin') holder.setVisibleOnAllWorkspaces(true);
    holder.showInactive();
    holder.on('closed', () => {
      if (this.holder === holder) this.holder = null;
    });
    this.holder = holder;
    return holder;
  }

  private async createTarget(context: AgentContext, url: string): Promise<Target> {
    const view = new WebContentsView({
      webPreferences: {
        session: context.ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.ensureHolder().contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, ...HIDDEN_SIZE });
    // Playwright adopts a tab whose first document has committed; a navigation
    // after it attaches would replace the main frame under it.
    await view.webContents.loadURL('about:blank');
    const t = await this.adopt(view, context, undefined);
    if (url !== 'about:blank') void view.webContents.loadURL(url);
    return t;
  }

  /** Make a tab (one this bridge created, or a page's popup) a target the host can drive. */
  private async adopt(
    view: WebContentsView,
    context: AgentContext,
    openerId: string | undefined,
  ): Promise<Target> {
    const wc = view.webContents;
    wc.debugger.attach('1.3');
    // Its own target id: Playwright requires it to equal the main frame's id.
    const { targetInfo } = (await wc.debugger.sendCommand('Target.getTargetInfo')) as {
      targetInfo: { targetId: string };
    };
    const t: Target = {
      targetId: targetInfo.targetId,
      sessionId: `S${++this.seq}.${targetInfo.targetId.slice(0, 8)}`,
      view,
      wc,
      context,
      ...(openerId ? { openerId } : {}),
      shownIn: null,
      bounds: { x: 0, y: 0, ...HIDDEN_SIZE },
    };
    this.targets.set(t.targetId, t);
    this.sessions.set(t.sessionId, { target: t });
    wc.debugger.on('message', (_e, method, params, childSessionId) => {
      const p = params as {
        sessionId?: string;
        targetId?: string;
        targetInfo?: { targetId?: string };
      };
      // Our own second sessions on this tab are not children for the client to
      // adopt or drop: one ending would read to Playwright as the page's main
      // frame going away.
      if (method === 'Target.attachedToTarget' && p.targetInfo?.targetId === t.targetId) return;
      if (method === 'Target.detachedFromTarget' && p.targetId === t.targetId) {
        if (p.sessionId) this.sessions.delete(p.sessionId);
        return;
      }
      if (method === 'Target.attachedToTarget' && p.sessionId) {
        this.sessions.set(p.sessionId, { target: t, child: p.sessionId });
      }
      if (method === 'Target.detachedFromTarget' && p.sessionId) this.sessions.delete(p.sessionId);
      this.send({ method, params, sessionId: childSessionId || t.sessionId });
    });
    wc.on('destroyed', () => this.dropTarget(t));
    wc.setWindowOpenHandler(() => ({
      action: 'allow',
      // A link that opens a new tab, or window.open: a tab of its own here,
      // keeping its opener, as in Chrome.
      createWindow: (options) => {
        // Electron passes the popup's own webContents in `options` (it is not in
        // the declared type): adopting it is what keeps `window.opener` working.
        const given = (options as { webContents?: WebContents }).webContents;
        const popup = new WebContentsView({
          ...(given ? { webContents: given } : {}),
          webPreferences: { ...options.webPreferences, backgroundThrottling: false },
        });
        this.ensureHolder().contentView.addChildView(popup);
        popup.setBounds({ x: 0, y: 0, ...HIDDEN_SIZE });
        void this.adopt(popup, context, t.targetId).catch((err: unknown) =>
          this.opts.log('agent browser: could not adopt a new tab', err),
        );
        return popup.webContents;
      },
    }));
    wc.on('context-menu', (_e, params) => {
      Menu.buildFromTemplate(
        buildContextMenuTemplate(params, {
          openExternal: (u) => void shell.openExternal(u),
          openInPatch: (u) => void wc.loadURL(u),
          writeText: (text) => clipboard.writeText(text),
          copyImageAt: (x, y) => wc.copyImageAt(x, y),
        }),
      ).popup();
    });
    wc.on('input-event', (_e, input) => {
      if (!t.shownIn) return;
      if (input.type === 'mouseDown' || input.type === 'rawKeyDown' || input.type === 'keyDown') {
        this.opts.onUserInput(t.shownIn, t.targetId);
      }
    });
    this.send({ method: 'Target.targetCreated', params: { targetInfo: this.info(t) } });
    if (this.autoAttach) this.announceAttached(t);
    return t;
  }

  private info(t: Target): Record<string, unknown> {
    return {
      targetId: t.targetId,
      type: 'page',
      title: t.wc.isDestroyed() ? '' : t.wc.getTitle(),
      url: t.wc.isDestroyed() ? '' : t.wc.getURL() || 'about:blank',
      attached: true,
      canAccessOpener: false,
      browserContextId: t.context.id,
      ...(t.openerId ? { openerId: t.openerId } : {}),
    };
  }

  private announceAttached(t: Target): void {
    this.send({
      method: 'Target.attachedToTarget',
      params: { sessionId: t.sessionId, targetInfo: this.info(t), waitingForDebugger: false },
    });
  }

  private detachView(t: Target): void {
    const from = t.shownIn ?? this.holder;
    if (from && !from.isDestroyed()) from.contentView.removeChildView(t.view);
  }

  private closeTarget(t: Target): void {
    if (!this.targets.has(t.targetId)) return;
    this.detachView(t);
    if (!t.wc.isDestroyed()) t.wc.close();
    this.dropTarget(t);
  }

  private dropTarget(t: Target): void {
    if (!this.targets.delete(t.targetId)) return;
    for (const [id, s] of this.sessions) if (s.target === t) this.sessions.delete(id);
    this.send({
      method: 'Target.detachedFromTarget',
      params: { sessionId: t.sessionId, targetId: t.targetId },
    });
    this.send({ method: 'Target.targetDestroyed', params: { targetId: t.targetId } });
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** `<home>/.patch/agent-browser.json`, where the host on this machine looks. */
export function agentBrowserEndpointFile(): string {
  return join(app.getPath('home'), '.patch', 'agent-browser.json');
}
