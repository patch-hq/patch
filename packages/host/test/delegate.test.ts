// patch_delegate — the durable subagent primitive (spec/06 § Cross-chat
// tools, spec/02 § Native subagent dispatch). Exercises the Daemon-level API
// (`createDelegate`/`listDelegates`/`stopDelegate`) directly, the same way
// cross-chat-tools.test.ts exercises patch_spawn/patch_watch, since a
// delegate is built into chatRunner.ts rather than a separate scheduler
// class: it IS an ordinary chat, carrying `meta.subagent`, so restart-resume
// and parallelism fall out of the ordinary chat machinery rather than being
// delegate-specific code paths worth re-testing here (see the "restart"
// describe block below for what that leaves to verify directly).

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon, SUBAGENT_PERMISSION_DENIED_MESSAGE } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend, type SdkBackend } from '../src/sdkBackend.js';
import { RecordImport } from '../src/recordImport.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-delegate-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    delegateOrphanSweepMs: 20,
    hostId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    discoverMcpServers: () => [],
  });
  return { daemon, sdk, events, home, folder, metaStore };
}

async function flushUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil: condition never became true');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function messagesOn(events: WireEvent[], chatId: string) {
  return events.filter(
    (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
      e.type === 'chat.message' && e.chatId === chatId,
  );
}

describe('patch_delegate', () => {
  it('fails a subagent to its parent when its session ends without reporting', async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    // The end-of-turn hook never runs: the session died.
    (daemon as unknown as { maybeSettleDelegate: () => void }).maybeSettleDelegate = () => {};
    sdk.enqueue([{ type: 'assistant', content: 'partial' }, { type: 'result' }]);
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'work' });
    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.includes(`agent ${id}] FAILED`)),
    );
    expect(
      messagesOn(events, parentChatId).find((m) => m.content.includes('FAILED'))!.content,
    ).toContain('the session ended without returning a result');
  });

  it("runs a child on the parent's pinned account, and leaves an unpinned parent's child automatic", async () => {
    const { daemon, sdk, folder } = setup();
    const spawned: Array<{ preferredAccountId?: string; subagent?: unknown }> = [];
    const realSpawn = daemon.spawnChat.bind(daemon);
    daemon.spawnChat = ((req) => {
      spawned.push(req);
      return realSpawn(req);
    }) as typeof daemon.spawnChat;
    const pinned = await daemon.spawnChat({ folder, preferredAccountId: 'acc-2' });
    const free = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'ok' }, { type: 'result' }]);
    await daemon.createDelegate({ parentChatId: pinned, prompt: 'a' });
    sdk.enqueue([{ type: 'assistant', content: 'ok' }, { type: 'result' }]);
    await daemon.createDelegate({ parentChatId: free, prompt: 'b' });
    const children = spawned.filter((r) => r.subagent !== undefined);
    expect(children[0]?.preferredAccountId).toBe('acc-2');
    expect(children[1]?.preferredAccountId).toBeUndefined();
  });

  it("picks a child's model: explicit > account agentDefaultModel > parent's", async () => {
    const { daemon, sdk, folder } = setup();
    const spawned: Array<{ model?: string; subagent?: unknown }> = [];
    const realSpawn = daemon.spawnChat.bind(daemon);
    daemon.spawnChat = ((req) => {
      spawned.push(req);
      return realSpawn(req);
    }) as typeof daemon.spawnChat;
    const parent = await daemon.spawnChat({ folder, model: 'parent-model' });
    const run = async (model?: string) => {
      sdk.enqueue([{ type: 'assistant', content: 'ok' }, { type: 'result' }]);
      await daemon.createDelegate({
        parentChatId: parent,
        prompt: 'x',
        ...(model ? { model } : {}),
      });
    };
    await run();
    (daemon as unknown as { opts: { agentDefaultModel: () => string } }).opts.agentDefaultModel =
      () => 'agent-model';
    await run();
    await run('explicit-model');
    const children = spawned.filter((r) => r.subagent !== undefined).map((r) => r.model);
    expect(children).toEqual(['parent-model', 'agent-model', 'explicit-model']);
  });

  it("moves a child with its parent when the parent's account changes, but not one with its own", async () => {
    const { daemon, sdk, folder } = setup();
    const parent = await daemon.spawnChat({ folder, preferredAccountId: 'acc-1' });
    sdk.enqueue([{ type: 'assistant', content: 'ok' }, { type: 'result' }]);
    const inherited = (await daemon.createDelegate({ parentChatId: parent, prompt: 'a' })).id;
    sdk.enqueue([{ type: 'assistant', content: 'ok' }, { type: 'result' }]);
    const own = (
      await daemon.createDelegate({
        parentChatId: parent,
        prompt: 'b',
        preferredAccountId: 'acc-3',
      })
    ).id;
    daemon.setChatPreferredAccount(parent, 'acc-2');
    expect(daemon.chatState.get(inherited)?.preferredAccountId).toBe('acc-2');
    expect(daemon.chatState.get(own)?.preferredAccountId).toBe('acc-3');
    daemon.setChatPreferredAccount(parent, null);
    expect(daemon.chatState.get(inherited)?.preferredAccountId).toBeUndefined();
    expect(daemon.chatState.get(own)?.preferredAccountId).toBe('acc-3');
  });

  it("locks a child to an explicitly named account, over the parent's own", async () => {
    const { daemon, sdk, folder } = setup();
    const spawned: Array<{ preferredAccountId?: string; subagent?: unknown }> = [];
    const realSpawn = daemon.spawnChat.bind(daemon);
    daemon.spawnChat = ((req) => {
      spawned.push(req);
      return realSpawn(req);
    }) as typeof daemon.spawnChat;
    const parent = await daemon.spawnChat({ folder, preferredAccountId: 'acc-2' });
    sdk.enqueue([{ type: 'assistant', content: 'ok' }, { type: 'result' }]);
    await daemon.createDelegate({ parentChatId: parent, prompt: 'a', preferredAccountId: 'acc-3' });
    const children = spawned.filter((r) => r.subagent !== undefined);
    expect(children[0]?.preferredAccountId).toBe('acc-3');
  });

  it('uses the given title as the label instead of the prompt', async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'ok' }, { type: 'result' }]);
    const { id, label } = await daemon.createDelegate({
      parentChatId,
      prompt: 'You are researching FOLK HISTORY sites and a very long brief follows',
      title: 'Folk history sites',
    });
    expect(label).toBe('Folk history sites');
    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.startsWith('[from Folk history')),
    );
    expect(messagesOn(events, parentChatId).find((m) => m.role === 'user')!.content).toBe(
      `[from Folk history sites; agent ${id}] ok`,
    );
  });

  it("delivers the subagent's FULL final reply to the parent as [from <label>], and is never on the wire itself", async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    const fullReply =
      'Here is the full multi-sentence result of the research task, which must arrive ' +
      'unabridged — every word of it, not a summary.';
    sdk.enqueue([{ type: 'assistant', content: fullReply }, { type: 'result' }]);

    const { id, label } = await daemon.createDelegate({
      parentChatId,
      prompt: 'Research the thing and report back in full',
    });
    expect(id).not.toBe(parentChatId);

    await flushUntil(() =>
      messagesOn(events, parentChatId).some(
        (m) => m.role === 'user' && m.content.includes(fullReply),
      ),
    );

    const delivered = messagesOn(events, parentChatId).find((m) => m.content.includes(fullReply))!;
    expect(delivered.content).toBe(`[from ${label}; agent ${id}] ${fullReply}`);

    // Invisible to the user: NOTHING addressed to the subagent's own chatId
    // ever reached the outbound relay — no chat.spawned, no chat.state, no
    // chat.message (spec/02 § Native subagent dispatch).
    expect(events.some((e) => (e as { chatId?: string }).chatId === id)).toBe(false);
    // Its entries go to the server's record only wrapped with their parent,
    // for the parent's read-only transcript.
    const wrapped = events.filter(
      (e): e is Extract<WireEvent, { type: 'host.delegate_entry' }> =>
        e.type === 'host.delegate_entry',
    );
    expect(wrapped.length).toBeGreaterThan(0);
    for (const w of wrapped) {
      expect(w.parentChatId).toBe(parentChatId);
      expect((w.event as { chatId?: string }).chatId).toBe(id);
    }
    expect(
      wrapped.some(
        (w) =>
          w.event.type === 'chat.message' &&
          (w.event as { role?: string; content?: string }).role === 'assistant' &&
          (w.event as { content?: string }).content === fullReply,
      ),
    ).toBe(true);

    const delegates = daemon.listDelegates(parentChatId);
    expect(delegates).toHaveLength(1);
    expect(delegates[0]).toMatchObject({ id, label, status: 'done' });
  });

  it('the subagent backfill reads an old subagent from disk and leaves no subagent chat loaded', async () => {
    const { daemon, sdk, folder, home, metaStore } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'the old answer' }, { type: 'result' }]);
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'look into it' });
    await flushUntil(() => daemon.listDelegates(parentChatId)[0]?.status === 'done');
    daemon.shutdown();

    // A later start of the host: the finished subagent has no work, so it is
    // not loaded.
    const later = new Daemon({
      hostId: 'd1',
      metaStore,
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      discoverClaudeMcpServers: () => [],
    });
    later.hydrate();
    expect(later.chatState.loaded(id)).toBeUndefined();

    const sent: WireEvent[] = [];
    const imp = new RecordImport({
      path: join(home, 'delegate-record-import.json'),
      logger: silent,
      listChats: () => later.subagentIds(),
      recordOf: (chatId) => later.delegateRecordForImport(chatId),
      parentOf: (chatId) => later.delegateParentOf(chatId),
      send: (e) => sent.push(e),
      defer: (fn) => fn(),
    });
    imp.start();
    const frame = sent[0] as Extract<WireEvent, { type: 'host.record_import' }>;
    expect(frame).toMatchObject({ chatId: id, parentChatId, done: true });
    expect(
      frame.events.some(
        (e) =>
          e.type === 'chat.message' && (e as { content?: string }).content === 'the old answer',
      ),
    ).toBe(true);
    imp.onAck(id);
    expect(imp.isComplete()).toBe(true);
    // Nothing the backfill touched stays held by the host.
    expect(later.chatState.loaded(id)).toBeUndefined();
    expect(later.chatState.list().some((c) => c.subagent !== undefined)).toBe(false);
  });

  it('delivers the reply when the stream stays open after the result (a detached background process)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-folder-')));
    const events: WireEvent[] = [];
    const sdk: SdkBackend = {
      ...createMockSdkBackend(),
      // The result lands, then the stream never closes — as when a command the
      // agent detached keeps the process's pipes open.
      async *run(opts) {
        yield { type: 'assistant', content: 'started the run, waiting', sessionId: 's1' };
        yield { type: 'result', sessionId: 's1' };
        await new Promise<void>((resolve) =>
          opts.abortController.signal.addEventListener('abort', () => resolve()),
        );
      },
    };
    let id = 0;
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
      discoverMcpServers: () => [],
    });
    const parentChatId = await daemon.spawnChat({ folder });
    const { id: childId } = await daemon.createDelegate({ parentChatId, prompt: 'long run' });
    await flushUntil(() =>
      messagesOn(events, parentChatId).some(
        (m) => m.role === 'user' && m.content.includes('started the run, waiting'),
      ),
    );
    expect(daemon.listDelegates(parentChatId)[0]).toMatchObject({ id: childId, status: 'done' });
    await daemon.stopChat(childId);
  });

  it('isSubagent is true for a delegate chat (live or finished) and false for ordinary and unknown chats', async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'done' }, { type: 'result' }]);
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'Do a thing' });
    expect(daemon.isSubagent(id)).toBe(true);
    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.includes('done')),
    );
    expect(daemon.isSubagent(id)).toBe(true);
    expect(daemon.isSubagent(parentChatId)).toBe(false);
    expect(daemon.isSubagent('pending-spawn')).toBe(false);
  });

  it('delivers an unrecoverable turn failure as a FAILED message, never silently', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-fail-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-fail-folder-')));
    mkdirSync(folder, { recursive: true });
    const events: WireEvent[] = [];
    const failing: SdkBackend = {
      async *run(): AsyncIterable<never> {
        throw new Error('session not found'); // terminal, non-retrying (isSessionInvalid)
      },
    };
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: failing,
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: (() => {
        let n = 0;
        return () => `fail-${++n}`;
      })(),
      discoverMcpServers: () => [],
    });
    const parentChatId = await daemon.spawnChat({ folder });

    const { id, label } = await daemon.createDelegate({
      parentChatId,
      prompt: 'this will fail',
    });

    await flushUntil(() =>
      messagesOn(events, parentChatId).some(
        (m) => m.role === 'user' && m.content.includes('FAILED'),
      ),
    );
    const delivered = messagesOn(events, parentChatId).find((m) => m.content.includes('FAILED'))!;
    expect(delivered.content).toContain(`[from ${label}; agent `);
    expect(delivered.content).toContain('FAILED');

    expect(daemon.listDelegates(parentChatId)).toEqual([
      expect.objectContaining({ id, status: 'failed' }),
    ]);
  });

  it('delivers the final reply of a later turn a settled subagent runs (woken by something other than its parent)', async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'interim: still working' }, { type: 'result' }]);
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'long job' });
    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.includes('interim: still working')),
    );

    // A background job the child started finishes and wakes it; it posts the final report.
    sdk.enqueue([{ type: 'assistant', content: 'FINAL REPORT' }, { type: 'result' }]);
    await daemon.sendInput({
      chatId: id,
      message: 'job finished',
      localId: 'wake-1',
      origin: 'machine',
    });

    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.includes('FINAL REPORT')),
    );
    expect(daemon.listDelegates(parentChatId)[0]).toMatchObject({ id, status: 'done' });
  });

  it('a child that ends a turn with a wake armed is not done: only its final report reaches the parent', async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    const wake = (daemon as unknown as { wake: { peek(id: string): unknown } }).wake;
    const spy = vi.spyOn(wake, 'peek').mockReturnValue({} as never);
    sdk.enqueue([{ type: 'assistant', content: 'still waiting' }, { type: 'result' }]);
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'long job' });
    await new Promise((r) => setTimeout(r, 300));
    expect(daemon.listDelegates(parentChatId)[0]).toMatchObject({ id, status: 'running' });
    expect(messagesOn(events, parentChatId).some((m) => m.content.includes('still waiting'))).toBe(
      false,
    );

    spy.mockReturnValue(null);
    sdk.enqueue([{ type: 'assistant', content: 'FINAL REPORT' }, { type: 'result' }]);
    await daemon.sendInput({ chatId: id, message: 'wake', localId: 'w1', origin: 'machine' });
    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.includes('FINAL REPORT')),
    );
    expect(daemon.listDelegates(parentChatId)[0]).toMatchObject({ id, status: 'done' });
  });

  it('does not deliver the same reply twice when a settled subagent is woken and says nothing new', async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'ONLY REPORT' }, { type: 'result' }]);
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'job' });
    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.includes('ONLY REPORT')),
    );

    // Something wakes the finished child; its turn adds no assistant message.
    sdk.enqueue([{ type: 'result' }]);
    await daemon.sendInput({ chatId: id, message: 'ping', localId: 'wake-x', origin: 'machine' });
    await new Promise((r) => setTimeout(r, 300));

    const delivered = messagesOn(events, parentChatId).filter(
      (m) =>
        m.role === 'user' && m.content.startsWith('[from') && m.content.includes('ONLY REPORT'),
    );
    expect(delivered).toHaveLength(1);
  });

  it('runs several delegates from the same parent in parallel, each delivering independently', async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'result one' }, { type: 'result' }]);
    sdk.enqueue([{ type: 'assistant', content: 'result two' }, { type: 'result' }]);

    const [a, b] = await Promise.all([
      daemon.createDelegate({ parentChatId, prompt: 'task A' }),
      daemon.createDelegate({ parentChatId, prompt: 'task B' }),
    ]);
    expect(a.id).not.toBe(b.id);

    await flushUntil(
      () =>
        messagesOn(events, parentChatId).some((m) => m.content.includes('result one')) &&
        messagesOn(events, parentChatId).some((m) => m.content.includes('result two')),
    );

    const statuses = daemon.listDelegates(parentChatId).map((d) => d.status);
    expect(statuses).toEqual(['done', 'done']);
  });

  /** A backend whose run() hangs until the turn is aborted — deterministically
   *  "running" for as long as the test needs, no timing race against the mock's
   *  normal (near-instant) completion. */
  function hangingBackend(): SdkBackend {
    return {
      async *run(opts): AsyncIterable<never> {
        await new Promise<void>((_resolve, reject) => {
          opts.abortController.signal.addEventListener(
            'abort',
            () => {
              const e = new Error('Request was aborted');
              e.name = 'AbortError';
              reject(e);
            },
            { once: true },
          );
        });
      },
    };
  }

  function setupHanging() {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-hang-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-hang-folder-')));
    mkdirSync(folder, { recursive: true });
    const events: WireEvent[] = [];
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: hangingBackend(),
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: (() => {
        let n = 0;
        return () => `hang-${++n}`;
      })(),
      discoverMcpServers: () => [],
    });
    return { daemon, events, folder };
  }

  it('restates a live subagent with its last activity as the clock moves, quiet since start otherwise', async () => {
    const events: WireEvent[] = [];
    let clock = 1_700_000_000_000;
    const daemon = new Daemon({
      delegateActivityRefreshMs: 20,
      hostId: 'd1',
      metaStore: createMetaStore(mkdtempSync(join(tmpdir(), 'patch-delegate-act-'))),
      sdkBackend: hangingBackend(),
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => clock,
      generateChatId: (() => {
        let n = 0;
        return () => `act-${++n}`;
      })(),
      discoverMcpServers: () => [],
    });
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-act-folder-')));
    const parentChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'a slow task' });
    const updates = () =>
      events.filter(
        (e): e is Extract<WireEvent, { type: 'chat.delegate_update' }> =>
          e.type === 'chat.delegate_update' && e.delegateId === id,
      );
    const first = updates().at(-1)!;
    expect(first.lastActivityAt).toBe(first.runStartedAt);

    // The subagent produces something later: the refresh restates it.
    clock += 90_000;
    (daemon as unknown as { delegateLastActivity: Map<string, number> }).delegateLastActivity.set(
      id,
      clock,
    );
    await flushUntil(() => updates().at(-1)!.lastActivityAt === clock);
    expect(updates().at(-1)).toMatchObject({ status: 'running', runStartedAt: first.runStartedAt });
    await daemon.stopChat(parentChatId);
  });

  it('patch_delegate_stop stops a running subagent and delivers nothing for it', async () => {
    const { daemon, events, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });

    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'a slow task' });
    // Allow the in-flight SDK run to actually reach the hanging backend's
    // await before stopping it, same as chatRunner.test.ts's "allow the
    // in-flight SDK run to flush" — otherwise stopChat's `aborters.get`
    // check can race the fire-and-forget prompt kickoff.
    await new Promise((r) => setTimeout(r, 20));
    expect(daemon.listDelegates(parentChatId)[0]?.status).toBe('running');

    const stopped = await daemon.stopDelegate(parentChatId, id);
    expect(stopped).toBe(true);

    expect(daemon.listDelegates(parentChatId)).toEqual([
      expect.objectContaining({ id, status: 'stopped' }),
    ]);
    // A stop is never reported as a result — the caller already knows.
    expect(messagesOn(events, parentChatId)).toHaveLength(0);

    // A second stop is a no-op, not an error (mirrors patch_watch_stop).
    expect(await daemon.stopDelegate(parentChatId, id)).toBe(false);
  });

  it('lists a subagent whose chat errored without settling as failed, not running', async () => {
    const { daemon, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'a slow task' });
    await new Promise((r) => setTimeout(r, 20));
    expect(daemon.listDelegates(parentChatId)[0]?.status).toBe('running');

    // Simulate the stranded case: the run is gone and the chat is errored.
    const d = daemon as unknown as {
      aborters: Map<string, unknown>;
      chatState: { setActivity(id: string, a: string): void };
    };
    d.aborters.delete(id);
    d.chatState.setActivity(id, 'errored');
    expect(daemon.listDelegates(parentChatId)[0]).toMatchObject({ id, status: 'failed' });
  });

  it('a user pause interrupts the turn without settling or reporting it, and stop still works', async () => {
    const { daemon, events, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'a slow task' });
    await new Promise((r) => setTimeout(r, 20));

    expect(await daemon.pauseDelegate(parentChatId, id)).toBe(true);
    // Alive, not settled: still running, flagged paused, nothing delivered.
    expect(daemon.listDelegates(parentChatId)).toEqual([
      expect.objectContaining({ id, status: 'running', paused: true }),
    ]);
    expect(messagesOn(events, parentChatId)).toHaveLength(0);
    const update = events
      .filter((e) => e.type === 'chat.delegate_update' && e.delegateId === id)
      .at(-1);
    expect(update).toMatchObject({ status: 'running', paused: true });

    // Pausing again is idempotent; a stranger's id is refused.
    expect(await daemon.pauseDelegate(parentChatId, id)).toBe(true);
    expect(await daemon.pauseDelegate('someone-else', id)).toBe(false);

    // A paused agent can still be stopped outright.
    expect(await daemon.stopDelegate(parentChatId, id)).toBe(true);
    expect(daemon.listDelegates(parentChatId)[0]).toMatchObject({ id, status: 'stopped' });
    expect(await daemon.pauseDelegate(parentChatId, id)).toBe(false);
  });

  it('resume only applies to a paused agent, and runs it again', async () => {
    const { daemon, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'a slow task' });
    await new Promise((r) => setTimeout(r, 20));

    expect(await daemon.resumeDelegate(parentChatId, id)).toBe(false);
    await daemon.pauseDelegate(parentChatId, id);
    expect(await daemon.resumeDelegate(parentChatId, id)).toBe(true);
    await flushUntil(() => daemon.listDelegates(parentChatId)[0]?.paused === undefined);
    expect(daemon.listDelegates(parentChatId)[0]?.status).toBe('running');
    await daemon.stopDelegate(parentChatId, id);
  });

  it('spinning off makes it an ordinary chat in the list and ends its reporting to the parent', async () => {
    const { daemon, events, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({
      parentChatId,
      prompt: 'a slow task',
      title: 'slow one',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(daemon.listWithFilter({}).map((c) => c.chatId)).not.toContain(id);

    expect(daemon.spinOffDelegate('someone-else', id)).toBeUndefined();
    expect(daemon.spinOffDelegate(parentChatId, id)).toBe(id);

    expect(daemon.isSubagent(id)).toBe(false);
    expect(daemon.delegateParentOf(id)).toBeUndefined();
    expect(daemon.listWithFilter({}).map((c) => c.chatId)).toContain(id);
    expect(daemon.listDelegates(parentChatId)).toEqual([]);
    expect(
      events.some(
        (e) => e.type === 'chat.spawned' && e.chatId === id && e.parentChatId === parentChatId,
      ),
    ).toBe(true);
    expect(events.at(-1)).toBeDefined();
    expect(
      events.filter((e) => e.type === 'chat.delegate_update' && e.delegateId === id).at(-1),
    ).toMatchObject({ status: 'stopped', spunOffChatId: id });
    // Spun off, it is no longer stopped with its parent.
    await daemon.stopChat(id);
  });

  it("counts a running subagent in the parent's chat.state backgroundTasks, and drops it once stopped", async () => {
    const { daemon, events, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });
    const lastCount = () =>
      events
        .filter(
          (e): e is Extract<WireEvent, { type: 'chat.state' }> =>
            e.type === 'chat.state' && e.chatId === parentChatId,
        )
        .at(-1)?.backgroundTasks;

    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'a slow task' });
    await flushUntil(() => lastCount() === 1);

    await daemon.stopDelegate(parentChatId, id);
    await flushUntil(() => lastCount() === 0);
  });

  it('reports the sub-agent share of the count as runningAgents', async () => {
    const { daemon, events, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });
    const last = () =>
      events
        .filter(
          (e): e is Extract<WireEvent, { type: 'chat.state' }> =>
            e.type === 'chat.state' && e.chatId === parentChatId,
        )
        .at(-1);

    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'a slow task' });
    await flushUntil(() => last()?.runningAgents === 1);
    expect(last()?.backgroundTasks).toBe(1);

    await daemon.stopDelegate(parentChatId, id);
    await flushUntil(() => last()?.runningAgents === 0);
  });

  it('builds a chat.state and lists delegates without scanning every chat on disk (reconnect does both per chat)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-scan-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-scan-folder-')));
    const store = createMetaStore(home);
    let listCalls = 0;
    const metaStore = {
      ...store,
      list: () => {
        listCalls++;
        return store.list();
      },
    };
    let n = 0;
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore,
      sdkBackend: hangingBackend(),
      oauthAccessToken: 'tok',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `scan-${++n}`,
      discoverMcpServers: () => [],
    });
    const parentChatId = await daemon.spawnChat({ folder });
    await daemon.createDelegate({ parentChatId, prompt: 'a slow task' });

    listCalls = 0;
    expect(daemon.currentStateEvent(parentChatId)?.backgroundTasks).toBe(1);
    expect(daemon.currentStateEvent(parentChatId)?.runningAgents).toBe(1);
    expect(listCalls).toBe(0);
    // A chat's replay lists its delegates, and a reconnect replays every chat.
    expect(daemon.listDelegates(parentChatId)).toHaveLength(1);
    expect(listCalls).toBe(0);
  });

  it("stopping a parent aborts the parent's own turn at once, not after its subagents settle", async () => {
    const aborted = new Map<string, number>();
    const backend: SdkBackend = {
      async *run(opts): AsyncIterable<never> {
        const id = String(opts.chatId);
        await new Promise<void>((_resolve, reject) => {
          opts.abortController.signal.addEventListener(
            'abort',
            () => {
              aborted.set(id, Date.now());
              // The subagent is slow to wind down; the parent is not.
              const settle = (): void => {
                const e = new Error('Request was aborted');
                e.name = 'AbortError';
                reject(e);
              };
              if (id === 'hang-1') settle();
              else setTimeout(settle, 400);
            },
            { once: true },
          );
        });
      },
    };
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-fast-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-fast-folder-')));
    let n = 0;
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: backend,
      oauthAccessToken: 'tok',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `hang-${++n}`,
      discoverMcpServers: () => [],
    });
    const parentChatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId: parentChatId, message: 'go', localId: 'L1' });
    await daemon.createDelegate({ parentChatId, prompt: 'a slow task' });
    await new Promise((r) => setTimeout(r, 20));

    const t0 = Date.now();
    const stopping = daemon.stopChat(parentChatId);
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted.has(parentChatId)).toBe(true);
    expect(aborted.get(parentChatId)! - t0).toBeLessThan(100);
    await stopping;
  });

  it('announces a new subagent as running the moment it is created', async () => {
    const { daemon, events, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'a slow task' });
    expect(events.filter((e) => e.type === 'chat.delegate_update' && e.delegateId === id)).toEqual([
      expect.objectContaining({ chatId: parentChatId, status: 'running' }),
    ]);
  });

  it("a chat cannot stop another chat's delegate", async () => {
    const { daemon, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });
    const strangerChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'task' });
    await new Promise((r) => setTimeout(r, 20));

    expect(await daemon.stopDelegate(strangerChatId, id)).toBe(false);
    expect(daemon.listDelegates(parentChatId)[0]?.status).toBe('running');

    await daemon.stopDelegate(parentChatId, id); // clean up the hung turn
  });

  it('archiving the parent stops its still-running subagents', async () => {
    const { daemon, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'task' });
    await new Promise((r) => setTimeout(r, 20));

    await daemon.setArchived(parentChatId, true);

    expect(daemon.listDelegates(parentChatId)).toEqual([
      expect.objectContaining({ id, status: 'stopped' }),
    ]);
  });

  it('a finished delegate is unaffected by a later archive/stop of its parent', async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'done already' }, { type: 'result' }]);
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'quick task' });
    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.includes('done already')),
    );

    await daemon.setArchived(parentChatId, true);
    expect(daemon.listDelegates(parentChatId)).toEqual([
      expect.objectContaining({ id, status: 'done' }),
    ]);
  });

  it("disables the user-facing tools for a subagent's turn, on top of the user's own toggles", async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-tools-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-tools-folder-')));
    mkdirSync(folder, { recursive: true });
    const disabledByChatId = new Map<string, string[] | undefined>();
    const capturingBackend: SdkBackend = {
      async *run(opts) {
        disabledByChatId.set(opts.chatId ?? '', opts.disabledTools);
        yield { type: 'assistant', content: 'ok' };
        yield { type: 'result' };
      },
    };
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: capturingBackend,
      oauthAccessToken: 'tok',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: (() => {
        let n = 0;
        return () => `tools-${++n}`;
      })(),
      discoverMcpServers: () => [],
    });
    const parentChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'task' });
    await new Promise((r) => setTimeout(r, 20));

    expect(disabledByChatId.get(id)).toEqual(
      expect.arrayContaining([
        'mcp__patch__patch_notify',
        'mcp__patch__patch_report',
        'mcp__patch__patch_call',
        'mcp__patch__patch_speak',
        'mcp__patch__patch_ask_human',
        'mcp__patch__patch_artifact',
        'mcp__patch__patch_agent',
        'mcp__patch__patch_spawn',
        'mcp__patch__patch_send_back',
        'mcp__patch__patch_send_to',
      ]),
    );
  });

  it("denies a subagent's permission request at once instead of raising it to the user", async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-ask-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-ask-folder-')));
    mkdirSync(folder, { recursive: true });
    const events: WireEvent[] = [];
    let denyMessage: string | undefined;
    let asked = false;
    const askingBackend: SdkBackend = {
      async *run(opts) {
        // Only the child asks; the parent's turn that receives its result must not.
        if (asked) {
          yield { type: 'result' };
          return;
        }
        asked = true;
        const decision = await opts.onPermissionRequest!({
          tool: 'AskUserQuestion',
          args: { question: 'Which approach?' },
          description: 'Which approach should I take?',
        });
        denyMessage = decision.denyMessage;
        yield { type: 'assistant', content: decision.approve ? 'took approach A' : 'gave up' };
        yield { type: 'result' };
      },
    };
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: askingBackend,
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: (() => {
        let n = 0;
        return () => `ask-${++n}`;
      })(),
      discoverMcpServers: () => [],
    });
    const parentChatId = await daemon.spawnChat({ folder, permissionMode: 'bypassPermissions' });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'pick an approach' });
    expect(daemon.chatPermissionMode(id)).toBe('bypassPermissions');

    await flushUntil(() => daemon.listDelegates(parentChatId)[0]?.status === 'done');
    expect(denyMessage).toBe(SUBAGENT_PERMISSION_DENIED_MESSAGE);
    expect(events.some((e) => e.type === 'chat.permission_request')).toBe(false);
    expect(daemon.chatState.get(parentChatId)?.activity).not.toBe('awaiting-permission');
    expect(daemon.listDelegates(parentChatId)[0]).toMatchObject({ id, status: 'done' });
  });

  describe('Task/Agent semantics — wait, capabilities, stay alive', () => {
    it('wait: true hands the final reply back inline and does NOT also deliver it as a [from] turn', async () => {
      const { daemon, sdk, events, folder } = setup();
      const parentChatId = await daemon.spawnChat({ folder });
      sdk.enqueue([{ type: 'assistant', content: 'the inline answer' }, { type: 'result' }]);
      const res = await daemon.createDelegate({ parentChatId, prompt: 'do it', wait: true });
      expect(res.result).toBeDefined();
      const settled = await res.result!;
      expect(settled).toEqual({ status: 'done', reply: 'the inline answer' });
      await new Promise((r) => setTimeout(r, 50));
      expect(
        messagesOn(events, parentChatId).some(
          (m) => m.role === 'user' && m.content.includes('[from '),
        ),
      ).toBe(false);
    });

    it('wait: true reports a failure inline too', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-delegate-waitfail-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-waitfail-f-')));
      const failing: SdkBackend = {
        async *run(): AsyncIterable<never> {
          throw new Error('session not found');
        },
      };
      let n = 0;
      const daemon = new Daemon({
        hostId: 'd1',
        metaStore: createMetaStore(home),
        sdkBackend: failing,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => `wf-${++n}`,
        discoverMcpServers: () => [],
      });
      const parentChatId = await daemon.spawnChat({ folder });
      const res = await daemon.createDelegate({ parentChatId, prompt: 'x', wait: true });
      const settled = await res.result!;
      expect(settled.status).toBe('failed');
      expect(settled.reply).toContain('FAILED');
    });

    it("disallowedTools are the subagent's capability limits, on top of the always-disabled set", async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-delegate-caps-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-caps-folder-')));
      const seen = new Map<string, string[] | undefined>();
      const backend: SdkBackend = {
        async *run(opts) {
          seen.set(opts.chatId ?? '', opts.disabledTools);
          yield { type: 'assistant', content: 'ok' };
          yield { type: 'result' };
        },
      };
      let n = 0;
      const daemon = new Daemon({
        hostId: 'd1',
        metaStore: createMetaStore(home),
        sdkBackend: backend,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => `caps-${++n}`,
        discoverMcpServers: () => [],
      });
      const parentChatId = await daemon.spawnChat({ folder });
      const { id } = await daemon.createDelegate({
        parentChatId,
        prompt: 'task',
        disallowedTools: ['Bash', 'Write'],
      });
      await flushUntil(() => seen.has(id));
      expect(seen.get(id)).toEqual(
        expect.arrayContaining(['Bash', 'Write', 'mcp__patch__patch_notify']),
      );
    });

    it('sendToDelegate re-arms a finished subagent, keeps its context, and returns the next reply', async () => {
      const { daemon, sdk, folder } = setup();
      const parentChatId = await daemon.spawnChat({ folder });
      sdk.enqueue([{ type: 'assistant', content: 'first' }, { type: 'result' }]);
      const first = await daemon.createDelegate({ parentChatId, prompt: 'start', wait: true });
      expect((await first.result!).reply).toBe('first');
      expect(daemon.listDelegates(parentChatId)[0]!.status).toBe('done');

      sdk.enqueue([{ type: 'assistant', content: 'second' }, { type: 'result' }]);
      const next = await daemon.sendToDelegate({
        parentChatId,
        id: first.id,
        message: 'and now this',
        wait: true,
      });
      expect(await next.result!).toEqual({ status: 'done', reply: 'second' });
      expect(daemon.listDelegates(parentChatId)).toHaveLength(1);
    });

    it('a follow-up wake restarts the run clock host-side and a reconnecting surface is told the same start', async () => {
      const { daemon, sdk, folder } = setup();
      const parentChatId = await daemon.spawnChat({ folder });
      sdk.enqueue([{ type: 'assistant', content: 'first' }, { type: 'result' }]);
      const first = await daemon.createDelegate({ parentChatId, prompt: 'start', wait: true });
      await first.result!;

      sdk.enqueue([{ type: 'assistant', content: 'second' }, { type: 'result' }]);
      const next = await daemon.sendToDelegate({
        parentChatId,
        id: first.id,
        message: 'again',
        wait: true,
      });
      await next.result!;
      const meta = (
        daemon as unknown as { opts: { metaStore: { read(id: string): any } } }
      ).opts.metaStore.read(first.id);
      expect(meta.subagent.followUp).toBe(true);
      expect(meta.subagent.runStartedAt).toBe(1_700_000_000_000);
    });

    it("sendToDelegate refuses another chat's subagent and a non-subagent", async () => {
      const { daemon, folder } = setup();
      const a = await daemon.spawnChat({ folder });
      const b = await daemon.spawnChat({ folder });
      const { id } = await daemon.createDelegate({ parentChatId: a, prompt: 'x' });
      await expect(daemon.sendToDelegate({ parentChatId: b, id, message: 'hi' })).rejects.toThrow(
        /not a subagent/,
      );
      await expect(
        daemon.sendToDelegate({ parentChatId: a, id: b, message: 'hi' }),
      ).rejects.toThrow(/not a subagent/);
    });
  });
});

describe('patch_delegate across a host restart', () => {
  function setupWaitGone() {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-gone-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-gone-f-')));
    const events: WireEvent[] = [];
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'assistant', content: 'done it' }, { type: 'result' }]);
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: (() => {
        let n = 0;
        return () => `gone-${++n}`;
      })(),
      discoverMcpServers: () => [],
    });
    return { daemon, events, folder };
  }

  function host(home: string, sdkBackend: SdkBackend) {
    const events: WireEvent[] = [];
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend,
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: (() => {
        let n = 0;
        return () => `r${++n}-${Math.random().toString(36).slice(2, 6)}`;
      })(),
      discoverMcpServers: () => [],
    });
    return { daemon, events };
  }
  const held: SdkBackend = {
    async *run() {
      await new Promise<void>(() => undefined);
    },
  } as unknown as SdkBackend;

  it('a background subagent cut off by a restart still delivers its result to the parent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-restart-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-restart-f-')));
    let parentChatId = '';
    let childId = '';
    {
      const { daemon } = host(home, held);
      parentChatId = await daemon.spawnChat({ folder });
      ({ id: childId } = await daemon.createDelegate({
        parentChatId,
        prompt: 'work',
        title: 'Worker',
      }));
      await new Promise((r) => setTimeout(r, 30));
      daemon.shutdown();
    }
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'assistant', content: 'all done' }, { type: 'result' }]);
    const { daemon, events } = host(home, sdk);
    daemon.hydrate();
    // The cut-off subagent is continued by the host itself: nobody is watching it.
    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.includes(`agent ${childId}`)),
    );
    expect(
      messagesOn(events, parentChatId)
        .map((m) => m.content)
        .join('\n'),
    ).toContain('all done');
    daemon.shutdown();
  });

  it('a settled subagent whose own child is cut off by a restart is woken by the result, and reports up', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-restart2-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-restart2-f-')));
    let topId = '';
    let midId = '';
    let leafId = '';
    {
      const sdk1 = createMockSdkBackend();
      sdk1.enqueue([{ type: 'assistant', content: 'waiting on leaf' }, { type: 'result' }]);
      let n = 0;
      const { daemon } = host(home, sdk1);
      topId = await daemon.spawnChat({ folder });
      ({ id: midId } = await daemon.createDelegate({
        parentChatId: topId,
        prompt: 'mid',
        title: 'Mid',
      }));
      await new Promise((r) => setTimeout(r, 50));
      // the middle agent has settled; now its own child starts and hangs
      (daemon as unknown as { opts: { sdkBackend: SdkBackend } }).opts.sdkBackend = held;
      ({ id: leafId } = await daemon.createDelegate({
        parentChatId: midId,
        prompt: 'leaf',
        title: 'Leaf',
      }));
      void n;
      await new Promise((r) => setTimeout(r, 30));
      daemon.shutdown();
    }
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'assistant', content: 'leaf finished' }, { type: 'result' }]);
    sdk.enqueue([{ type: 'assistant', content: 'mid relays leaf finished' }, { type: 'result' }]);
    const { daemon, events } = host(home, sdk);
    daemon.hydrate();
    await daemon.continueChat(leafId);
    await flushUntil(() =>
      messagesOn(events, topId).some((m) => m.content.includes('mid relays leaf finished')),
    );
    expect(leafId).not.toBe('');
    daemon.shutdown();
  });

  it('a waiting caller that went away gets the result delivered to the parent as a turn instead', async () => {
    const { daemon, events, folder } = setupWaitGone();
    const parentChatId = await daemon.spawnChat({ folder });
    const { id, result } = await daemon.createDelegate({
      parentChatId,
      prompt: 'work',
      title: 'Worker',
      wait: true,
    });
    void result;
    daemon.abandonDelegateWait(id);
    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.includes(`agent ${id}`)),
    );
    expect(
      messagesOn(events, parentChatId)
        .map((m) => m.content)
        .join('\n'),
    ).toContain('done it');
  });
});
