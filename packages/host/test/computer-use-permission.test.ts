// Computer use (patch_browser_mouse / patch_browser_key) is off by default: a
// chat's first use asks Deny / Allow / Always allow, and only an "Always allow"
// is remembered beyond that chat (host.json, via `computerUse.setAlwaysAllowed`).

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon, COMPUTER_USE_TOOL, type BrowserManager } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(initiallyAlwaysAllowed = false) {
  const home = mkdtempSync(join(tmpdir(), 'patch-cu-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-cu-folder-')));
  const events: WireEvent[] = [];
  let id = 0;
  let always = initiallyAlwaysAllowed;
  const browser = {
    pointer: vi.fn(async () => {}),
    pressKeys: vi.fn(async () => {}),
    screenshot: vi.fn(async () => ({ data: 'x', mimeType: 'image/png' })),
    viewport: vi.fn(async () => ({ width: 10, height: 10 })),
    dispose: vi.fn(async () => {}),
  };
  const setAlwaysAllowed = vi.fn(() => {
    always = true;
  });
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    permissionModeDefault: 'default',
    browser: browser as unknown as BrowserManager,
    computerUse: { alwaysAllowed: () => always, setAlwaysAllowed },
  });
  return { daemon, events, folder, browser, setAlwaysAllowed };
}

const click = { action: 'click' as const, x: 1, y: 2 };
const tick = () => new Promise((r) => setTimeout(r, 20));

function lastRequest(events: WireEvent[]): { requestId: string; request: { tool: string } } {
  const reqs = events.filter((e) => e.type === 'chat.permission_request');
  return reqs[reqs.length - 1] as unknown as { requestId: string; request: { tool: string } };
}

describe('computer use permission', () => {
  it('asks first, and does nothing until answered', async () => {
    const { daemon, events, folder, browser } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await tick();
    const call = daemon.browserMouse(chatId, 't1', click);
    await tick();
    expect(lastRequest(events).request.tool).toBe(COMPUTER_USE_TOOL);
    expect(browser.pointer).not.toHaveBeenCalled();
    daemon.submitPermissionResponse({
      requestId: lastRequest(events).requestId,
      decision: 'approve',
    });
    await call;
    expect(browser.pointer).toHaveBeenCalledTimes(1);
  });

  it('Deny fails the call and acts on nothing', async () => {
    const { daemon, events, folder, browser } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await tick();
    const call = daemon.browserKey(chatId, 't1', ['Enter']);
    const assertion = expect(call).rejects.toThrow(/denied/i);
    await tick();
    daemon.submitPermissionResponse({
      requestId: lastRequest(events).requestId,
      decision: 'deny',
    });
    await assertion;
    expect(browser.pressKeys).not.toHaveBeenCalled();
  });

  it('Allow covers the rest of that chat but is not stored for the host', async () => {
    const { daemon, events, folder, setAlwaysAllowed } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await tick();
    const first = daemon.browserMouse(chatId, 't1', click);
    await tick();
    daemon.submitPermissionResponse({
      requestId: lastRequest(events).requestId,
      decision: 'approve',
    });
    await first;
    const asked = events.filter((e) => e.type === 'chat.permission_request').length;
    await daemon.browserKey(chatId, 't1', ['Enter']);
    expect(events.filter((e) => e.type === 'chat.permission_request').length).toBe(asked);
    expect(setAlwaysAllowed).not.toHaveBeenCalled();
  });

  it('Always allow is stored, so no chat is asked again', async () => {
    const { daemon, events, folder, setAlwaysAllowed } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await tick();
    const first = daemon.browserMouse(chatId, 't1', click);
    await tick();
    daemon.submitPermissionResponse({
      requestId: lastRequest(events).requestId,
      decision: 'approve_with_session_allow',
    });
    await first;
    expect(setAlwaysAllowed).toHaveBeenCalledTimes(1);
    const asked = events.filter((e) => e.type === 'chat.permission_request').length;
    await daemon.browserMouse('some-other-chat', 't1', click);
    expect(events.filter((e) => e.type === 'chat.permission_request').length).toBe(asked);
  });

  it('a standing Always allow skips the question entirely', async () => {
    const { daemon, events, folder, browser } = setup(true);
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await tick();
    await daemon.browserMouse(chatId, 't1', click);
    expect(browser.pointer).toHaveBeenCalled();
    expect(events.some((e) => e.type === 'chat.permission_request')).toBe(false);
  });
});
