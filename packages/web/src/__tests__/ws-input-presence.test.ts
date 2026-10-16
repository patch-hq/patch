// spec/09 § Presence heuristic — the surface reports how long since the user
// last touched the computer, every 15s, whether or not Patch is on screen.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs } from '../api/ws.js';
import {
  INPUT_REPORT_INTERVAL_MS,
  __resetIdleDetection,
  __setLastPageInputAt,
  idleDetectionState,
  idleDetectionSupported,
  listenForPageInput,
  readInputReport,
  requestIdleDetection,
  startIdleDetection,
} from '../lib/inputPresence.js';

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 1;
  url: string;
  sent: string[] = [];
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
    queueMicrotask(() => this.emit('open', {}));
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
  addEventListener(name: string, cb: (e: MessageEvent) => void): void {
    (this.listeners[name] ??= []).push(cb);
  }
  removeEventListener(): void {}
  emit(name: string, data: unknown): void {
    for (const cb of this.listeners[name] ?? []) cb(data as MessageEvent);
  }
  receive(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }
}

const inputs = (f: FakeWS) =>
  f.sent.filter((s) => s.includes('"surface.input"')).map((s) => JSON.parse(s));

describe('input presence', () => {
  afterEach(() => {
    delete (window as unknown as { patch?: unknown }).patch;
  });

  it('in a browser, reports time since input on this page', async () => {
    __setLastPageInputAt(1_000);
    expect(await readInputReport(31_000)).toEqual({
      type: 'surface.input',
      idleMs: 30_000,
      scope: 'page',
    });
  });

  it('a key press on the page resets it', async () => {
    listenForPageInput();
    __setLastPageInputAt(0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    const { idleMs } = await readInputReport(Date.now());
    expect(idleMs).toBeLessThan(1000);
  });

  it('in the desktop app, reports input anywhere on the machine', async () => {
    (window as unknown as { patch: unknown }).patch = { getSystemIdleMs: async () => 4200.4 };
    __setLastPageInputAt(0);
    expect(await readInputReport(10 * 60_000)).toEqual({
      type: 'surface.input',
      idleMs: 4200,
      scope: 'system',
    });
  });

  it('a shell that fails to say is an error, not the page answer in disguise', async () => {
    (window as unknown as { patch: unknown }).patch = {
      getSystemIdleMs: async () => {
        throw new Error('ipc gone');
      },
    };
    await expect(readInputReport()).rejects.toThrow('ipc gone');
  });
});

describe('PatchWs input reports', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
    (window as unknown as { patch: unknown }).patch = { getSystemIdleMs: async () => 3000 };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { patch?: unknown }).patch;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('reports on auth, then every 15s — and keeps going while the window is hidden', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    await vi.advanceTimersByTimeAsync(10);
    expect(inputs(fake)).toEqual([{ type: 'surface.input', idleMs: 3000, scope: 'system' }]);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(INPUT_REPORT_INTERVAL_MS * 2 + 10);
    expect(inputs(fake)).toHaveLength(3);
    ws.close();
  });

  it('stops reporting once closed', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    await vi.advanceTimersByTimeAsync(10);
    ws.close();
    const n = inputs(fake).length;
    await vi.advanceTimersByTimeAsync(INPUT_REPORT_INTERVAL_MS * 3);
    expect(inputs(fake)).toHaveLength(n);
  });
});

describe('away reports from the desktop shell', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { patch?: unknown }).patch;
  });

  it('carries away: locked or asleep from the machine', async () => {
    for (const away of ['locked', 'asleep'] as const) {
      (window as unknown as { patch: unknown }).patch = {
        getSystemPresence: async () => ({ idleMs: 1200, away }),
      };
      expect(await readInputReport()).toEqual({
        type: 'surface.input',
        idleMs: 1200,
        scope: 'system',
        away,
      });
    }
  });

  it('leaves away out when the machine is in use', async () => {
    (window as unknown as { patch: unknown }).patch = {
      getSystemPresence: async () => ({ idleMs: 50 }),
    };
    expect(await readInputReport()).toEqual({ type: 'surface.input', idleMs: 50, scope: 'system' });
  });

  it('reports at once when the shell says the machine locked, without waiting for the tick', async () => {
    let away: 'locked' | undefined;
    let fire: () => void = () => undefined;
    const unsubscribe = vi.fn();
    (window as unknown as { patch: unknown }).patch = {
      getSystemPresence: async () => ({ idleMs: 0, ...(away ? { away } : {}) }),
      onSystemAwayChange: (cb: () => void) => {
        fire = cb;
        return unsubscribe;
      },
    };
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    await vi.advanceTimersByTimeAsync(10);
    expect(inputs(fake)).toHaveLength(1);

    away = 'locked';
    fire();
    await vi.advanceTimersByTimeAsync(10);
    expect(inputs(fake)).toHaveLength(2);
    expect(inputs(fake)[1]).toMatchObject({ away: 'locked', scope: 'system' });

    ws.close();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe('browser idle detection', () => {
  type Listener = () => void;
  class FakeDetector {
    static permission: 'granted' | 'denied' = 'granted';
    static last: FakeDetector | null = null;
    userState: 'active' | 'idle' | null = 'active';
    screenState: 'locked' | 'unlocked' | null = 'unlocked';
    listeners: Listener[] = [];
    started: { threshold: number } | null = null;
    constructor() {
      FakeDetector.last = this;
    }
    static async requestPermission() {
      return FakeDetector.permission;
    }
    addEventListener(_: string, cb: Listener) {
      this.listeners.push(cb);
    }
    async start(o: { threshold: number }) {
      this.started = o;
    }
    change(user: 'active' | 'idle', screen: 'locked' | 'unlocked' = 'unlocked') {
      this.userState = user;
      this.screenState = screen;
      this.listeners.forEach((l) => l());
    }
  }
  let permissionState: 'granted' | 'prompt' | 'denied';

  beforeEach(() => {
    __resetIdleDetection();
    FakeDetector.last = null;
    FakeDetector.permission = 'granted';
    permissionState = 'granted';
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    (window as unknown as { IdleDetector: unknown }).IdleDetector = FakeDetector;
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: async () => ({ state: permissionState }) },
    });
  });
  afterEach(() => {
    delete (window as unknown as { IdleDetector?: unknown }).IdleDetector;
    delete (window as unknown as { patch?: unknown }).patch;
    __resetIdleDetection();
  });

  it('is offered only where the browser has it, never in the desktop app', async () => {
    expect(idleDetectionSupported()).toBe(true);
    expect(await idleDetectionState()).toBe('granted');
    (window as unknown as { patch: unknown }).patch = { getSystemPresence: async () => ({}) };
    expect(idleDetectionSupported()).toBe(false);
    expect(await idleDetectionState()).toBe('unsupported');
    delete (window as unknown as { patch?: unknown }).patch;
    delete (window as unknown as { IdleDetector?: unknown }).IdleDetector;
    expect(await idleDetectionState()).toBe('unsupported');
  });

  it('without a grant the tab reports only its own page and starts nothing', async () => {
    permissionState = 'prompt';
    await startIdleDetection();
    expect(FakeDetector.last).toBeNull();
    __setLastPageInputAt(0);
    expect(await readInputReport(5000)).toMatchObject({ scope: 'page', idleMs: 5000 });
  });

  it('once granted, reports the whole machine at the browser’s 60s minimum threshold', async () => {
    await startIdleDetection(() => 1_000_000);
    expect(FakeDetector.last?.started).toEqual({ threshold: 60_000 });
    __setLastPageInputAt(0);
    // The machine saw input within a minute, so however long the page has been quiet it is under it.
    const active = await readInputReport(1_000_000);
    expect(active).toMatchObject({ scope: 'system' });
    expect(active.idleMs).toBeLessThan(60_000);
    expect(active.away).toBeUndefined();
  });

  it('idle is reported from when the detector said so, backdated by its threshold', async () => {
    let t = 1_000_000;
    await startIdleDetection(() => t);
    t = 2_000_000;
    FakeDetector.last!.change('idle');
    t = 2_030_000;
    const r = await readInputReport(t);
    expect(r).toMatchObject({ scope: 'system', idleMs: 90_000 });
  });

  it('a locked screen is away: locked, and the change is reported at once', async () => {
    const changed = vi.fn();
    const { onIdleDetectionChange } = await import('../lib/inputPresence.js');
    onIdleDetectionChange(changed);
    await startIdleDetection();
    FakeDetector.last!.change('idle', 'locked');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await readInputReport()).toMatchObject({ scope: 'system', away: 'locked' });
    FakeDetector.last!.change('active', 'unlocked');
    expect((await readInputReport()).away).toBeUndefined();
  });

  it('the button asks the browser, starts detecting on a grant and says so on a refusal', async () => {
    permissionState = 'prompt';
    FakeDetector.permission = 'denied';
    expect(await requestIdleDetection()).toBe('denied');
    expect(FakeDetector.last).toBeNull();
    FakeDetector.permission = 'granted';
    permissionState = 'granted';
    expect(await requestIdleDetection()).toBe('granted');
    expect(FakeDetector.last?.started).toEqual({ threshold: 60_000 });
  });
});
