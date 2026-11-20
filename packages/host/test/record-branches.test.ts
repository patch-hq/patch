// Each entry's branch reaches the server's record with it (spec/04 § Branching,
// spec/01 § Chat record): the active track's entries carry their branch, a side
// branch's entries go to the record only, never out as live events, and a
// server that does not keep branches is sent neither.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import WS, { type WebSocket } from 'ws';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { createServerLink } from '../src/serverLink.js';
import { Outbox } from '../src/outbox.js';
import { createClaudeSessionProbe } from '../src/history.js';

const silent = pino({ level: 'silent' });
const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const projectsRoot = tmp('record-branches-projects-');
  const sdk = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
  const events: WireEvent[] = [];
  const recorded: WireEvent[] = [];
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(tmp('record-branches-')),
    sdkBackend: sdk,
    sessionProbe: createClaudeSessionProbe({ claudeProjectsRoot: projectsRoot }),
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    recordOnly: (e) => recorded.push(e),
    logger: silent,
  });
  return { daemon, sdk, events, recorded, folder: tmp('record-branches-folder-') };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("an entry's branch, for the server's record", () => {
  it('every entry the host sends carries the branch it was logged on', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'question', localId: 'L1' });
    await settle();
    const root = daemon.branchesEvent(chatId).activeBranchId;
    const entries = events.filter((e) => e.type === 'chat.message');
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e).toMatchObject({ branchId: root });
    // The import says the same.
    for (const e of daemon.recordForImport(chatId).filter((x) => x.type === 'chat.message')) {
      expect(e).toMatchObject({ branchId: root });
    }
    daemon.shutdown();
  });

  it("a side branch's entries go to the record only, never out live", async () => {
    const { daemon, events, recorded, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'L1' });
    await settle();
    const first = events.find((e) => e.type === 'chat.message' && e.role === 'assistant') as {
      seq: number;
    };
    events.length = 0;
    await daemon.sideChat({ chatId, seq: first.seq, message: 'aside', localId: 'S1' });
    await settle();
    const side = daemon.branchesEvent(chatId).branches.find((b) => b.sideThread === true)!;
    expect(side).toBeDefined();
    const asked = recorded.find((e) => e.type === 'chat.message' && e.role === 'user');
    expect(asked).toMatchObject({ content: 'aside', branchId: side.branchId });
    expect(recorded.every((e) => (e as { branchId?: string }).branchId === side.branchId)).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'chat.message')).toBe(false);
    daemon.shutdown();
  });
});

class FakeSocket extends EventEmitter {
  readyState: number = WS.CONNECTING;
  sent: Record<string, unknown>[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  ping(): void {}
  terminate(): void {
    this.close();
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState === WS.CLOSED) return;
    this.readyState = WS.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }
  open(): void {
    this.readyState = WS.OPEN;
    this.emit('open');
  }
  receive(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }
}

describe('the server link and entry branches', () => {
  const say = {
    type: 'chat.message',
    chatId: 'c1',
    role: 'assistant',
    content: 'm',
    seq: 1,
    branchId: 'b1',
  } as WireEvent;

  async function linkWith(greeting: Record<string, unknown>) {
    const sockets: FakeSocket[] = [];
    const link = createServerLink({
      url: 'ws://x/ws',
      daemonKey: 'k',
      clientVersion: '1',
      logger: silent,
      outbox: new Outbox({
        path: join(tmp('record-branches-outbox-'), 'outbox.jsonl'),
        logger: silent,
      }),
      backoffSchedule: [60_000],
      heartbeatIntervalMs: 60_000,
      wsFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
    });
    link.start();
    const s = sockets[0]!;
    s.open();
    s.receive({
      type: 'auth.ok',
      accountId: 'a',
      surfaceId: 'h1',
      hosts: [],
      hostOutbox: true,
      recordComplete: true,
      ...greeting,
    });
    s.sent.length = 0;
    return { link, s };
  }

  const sentEvents = (s: FakeSocket): unknown[] =>
    s.sent.map((f) => (f['type'] === 'host.outbox' ? f['event'] : f));

  it('a server that keeps branches is sent them, and says so', async () => {
    const { link, s } = await linkWith({ recordBranches: true });
    expect(link.keepsBranches()).toBe(true);
    link.send(say);
    expect(sentEvents(s)).toEqual([say]);
    await link.close();
  });

  it("an older server is sent the entry without its branch, and a permission request's branch stays", async () => {
    const { link, s } = await linkWith({});
    expect(link.keepsBranches()).toBe(false);
    link.send(say);
    const request = {
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'Bash', args: {} },
      seq: 2,
      branchId: 'b1',
    } as WireEvent;
    link.send(request);
    const { branchId: _b, ...bare } = say as WireEvent & { branchId: string };
    void _b;
    expect(sentEvents(s)).toEqual([bare, request]);
    await link.close();
  });
});
