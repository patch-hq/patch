// A host restart kills every in-flight turn on the host, and the last thing
// every deploy does is restart the host. Before this, that work simply stopped:
// the server resolved the chat to `errored` / `daemon_unavailable` and waited
// for a human. It is this that lets that error say "Connection to the host was
// lost. Message will resend." instead of asking the user to resend it.
//
// So the pump mirrors what the chat still owes the agent into meta.json
// (`pendingTurns`), and `hydrate` puts it back.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon, CONTINUE_MESSAGE } from '../src/chatRunner.js';
import { createMetaStore, type MetaStore } from '../src/meta.js';
import { entryText, transcriptFor } from './helpers/chatTranscript.js';
import { createMockSdkBackend, TurnFailedError, type SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

/** A backend whose turns block until released — holds a turn in `running`. */
function gatedBackend() {
  const gates: Array<() => void> = [];
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
      prompts.push(opts.prompt);
      await new Promise<void>((resolve) => gates.push(resolve));
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
    },
  };
  return {
    backend,
    prompts,
    releaseNext: (): void => void gates.shift()?.(),
    /**
     * Run the pump dry. Releasing the gates that exist right now only frees the
     * turn in the SDK — the one that drains in behind it registers a gate of its
     * own — so releasing has to be repeated until nothing new appears.
     */
    drain: async (): Promise<void> => {
      for (let i = 0; i < 10; i++) {
        while (gates.length > 0) gates.shift()?.();
        await new Promise((r) => setTimeout(r, 15));
      }
    },
  };
}

/**
 * A host over `home`. Restarting is modelled as building a SECOND host over
 * the SAME patch home — which is exactly what systemd does on `restart`: the
 * process is replaced, ~/.patch is not.
 */
function hostOver(home: string, backend: SdkBackend, accountId?: string) {
  const events: WireEvent[] = [];
  let id = 0;
  const metaStore = createMetaStore(home);
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: backend,
    ...(accountId === undefined
      ? { oauthAccessToken: 'fake-token' }
      : {
          resolveOAuth: () => ({
            ok: true as const,
            accessToken: 'fake-token',
            accountId,
          }),
        }),
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, events, metaStore };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-resume-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rfolder-')));
  mkdirSync(folder, { recursive: true });
  return { home, folder };
}

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

const pendingOf = (metaStore: MetaStore, chatId: string) =>
  metaStore.read(chatId)?.pendingTurns ?? [];

/** Spawn a chat and settle one turn, so it has a resumable claudeSessionId. */
async function chatWithHistory(daemon: Daemon, folder: string, g: ReturnType<typeof gatedBackend>) {
  const chatId = await daemon.spawnChat({ folder });
  void daemon.sendInput({ chatId, message: 'first', localId: 'L0' });
  await tick();
  g.releaseNext();
  await tick();
  return chatId;
}

describe('resuming turns a host restart interrupted', () => {
  it('rebuilds from Patch history instead of sending account A session to account B', async () => {
    const firstBackend = gatedBackend();
    const { home, folder } = setup();
    const first = hostOver(home, firstBackend.backend, 'account-a');
    const chatId = await chatWithHistory(first.daemon, folder, firstBackend);
    expect(first.metaStore.read(chatId)?.claudeSessionAccountId).toBe('account-a');

    // Leave a genuinely running turn for restart recovery.
    void first.daemon.sendInput({ chatId, message: 'running', localId: 'switch-L1' });
    await tick();

    const seenResumeIds: Array<string | undefined> = [];
    const secondBackend: SdkBackend = {
      async *run(opts) {
        seenResumeIds.push(opts.resumeSessionId);
        yield { type: 'result', sessionId: 'account-b-session' };
      },
    };
    const second = hostOver(home, secondBackend, 'account-b');
    second.daemon.hydrate();
    await tick(50);
    // Nothing is sent until the user continues the interrupted turn.
    expect(seenResumeIds).toHaveLength(0);
    await second.daemon.continueChat(chatId);
    await tick(50);

    expect(seenResumeIds).toHaveLength(1);
    expect(seenResumeIds[0]).not.toBe('sess');
    expect(second.metaStore.read(chatId)?.claudeSessionAccountId).toBe('account-b');
    expect(second.metaStore.read(chatId)?.claudeSessionId).toBe('account-b-session');
  });

  it('records the running turn and everything queued behind it, in order', async () => {
    const g = gatedBackend();
    const { home, folder } = setup();
    const { daemon, metaStore } = hostOver(home, g.backend);
    const chatId = await chatWithHistory(daemon, folder, g);

    // A settled chat owes nothing.
    expect(pendingOf(metaStore, chatId)).toEqual([]);

    void daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'queued-a', localId: 'L2' });
    void daemon.sendInput({ chatId, message: 'queued-b', localId: 'L3' });
    await tick();

    // Head is the turn actually in the SDK; the rest are its queue, in arrival
    // order — i.e. exactly what a kill right now would destroy.
    // The head also carries `retryOfSeq` — the seq of the user bubble it is
    // ALREADY drawn as on every surface (spec/12 § A turn is owed until it
    // settles). Without it the resume below re-sends a message every surface
    // already has and draws it a second time, which is the duplicate-bubble
    // bug. The queued two have never run, so they have no bubble to name.
    expect(pendingOf(metaStore, chatId)).toEqual([
      { message: 'running', localId: 'L1', retryOfSeq: 2 },
      { message: 'queued-a', localId: 'L2' },
      { message: 'queued-b', localId: 'L3' },
    ]);

    await g.drain();
    expect(pendingOf(metaStore, chatId)).toEqual([]);
  });

  // live: a restart sometimes seemed to reprompt a conversation that had
  // already finished. The log's own `turn.end` is fsynced durably the moment
  // the turn settles, but `persistPendingTurns` — the meta.json rewrite that
  // would clear the now-stale head entry — is a SEPARATE write straight after
  // it, with nothing atomic tying the two together. A process killed in that
  // gap (a hard kill, not the graceful path above) leaves the log correctly
  // showing the turn as `completed` while meta.json still calls it owed.
  it('does not resend a pendingTurns head the chat log already shows settled', async () => {
    const g = gatedBackend();
    const { home, folder } = setup();
    const { daemon, metaStore } = hostOver(home, g.backend);
    const chatId = await chatWithHistory(daemon, folder, g);

    void daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    g.releaseNext();
    await tick();
    // The turn genuinely completed — nothing owed, exactly like any other
    // settled turn.
    expect(pendingOf(metaStore, chatId)).toEqual([]);

    // Simulate the exact race: a process killed between the log's own
    // turn.end (already durable) and the meta.json rewrite that would have
    // cleared this. Force the stale head back the way that kill would leave it.
    metaStore.update(chatId, (m) => ({
      ...m,
      pendingTurns: [{ message: 'running', localId: 'L1', retryOfSeq: 2 }],
    }));

    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    // The chat's own transcript already has this turn's full reply — resending
    // it as "Carry on" would reprompt a finished conversation, so nothing goes
    // out, and the stale marker is cleared rather than repeatedly retried.
    expect(g2.prompts).toEqual([]);
    expect(pendingOf(second.metaStore, chatId)).toEqual([]);
  });

  // live (2026-10-15, "Mac Host Offline Issues", stuck 68 minutes): the
  // check above — drop `recorded[0]` whenever the log shows the last turn
  // `completed`/`stopped` — has the SAME log/meta.json shape for a second,
  // DIFFERENT race: a turn settles cleanly (meta.json's rewrite WINS this
  // time, dropping it from `pendingTurns`), and the process is killed in the
  // gap before `drainQueue` starts the turn that was queued behind it. That
  // queued turn, never the settled one, is what is actually sitting at
  // `recorded[0]` on the next restart — dropping it unconditionally loses it
  // forever: nothing ever resends it, and the chat is left showing whatever
  // activity it last broadcast ("running") with nothing running.
  it('resends a turn queued behind one that settled cleanly just before the kill', async () => {
    const g = gatedBackend();
    const { home, folder } = setup();
    const { daemon, metaStore } = hostOver(home, g.backend);
    const chatId = await chatWithHistory(daemon, folder, g);

    void daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    g.releaseNext();
    await tick();
    // The turn genuinely completed — nothing owed, same as the stale-head
    // test above up to this point.
    expect(pendingOf(metaStore, chatId)).toEqual([]);

    // Simulate the exact race: a turn was queued right behind 'running' and
    // `persistPendingTurns` had already re-written meta.json to reflect it
    // (the settled turn is gone, the queued one is now `recorded[0]`) when
    // the process was killed — before `drainQueue` ever started it, so the
    // chat log has no `turn.start` for it at all.
    metaStore.update(chatId, (m) => ({
      ...m,
      pendingTurns: [{ message: 'queued-next', localId: 'L2' }],
    }));

    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    // This is a turn that never began — it goes out like any other queued
    // entry, verbatim and without the cut-off framing — not dropped as a
    // stale duplicate of 'running', which is a different turn entirely.
    expect(g2.prompts).toEqual(['queued-next']);
    expect(second.daemon.chatState.get(chatId)?.activity).toBe('running');
  });

  // The turn a restart cut off is not owed any more: it is recorded as
  // interrupted, and stays so across further restarts until it is continued.
  it('records a cut-off turn as interrupted, not owed, and keeps it so across restarts', async () => {
    const g = gatedBackend();
    const { home, folder } = setup();
    const first = hostOver(home, g.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g);
    void first.daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    expect(pendingOf(first.metaStore, chatId)).toEqual([
      { message: 'running', localId: 'L1', retryOfSeq: 2 },
    ]);

    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();
    expect(g2.prompts).toEqual([]);
    expect(pendingOf(second.metaStore, chatId)).toEqual([]);
    expect(second.metaStore.read(chatId)?.interrupted).toBe(true);

    // Killed again before anyone pressed Continue: still interrupted.
    const g3 = gatedBackend();
    const third = hostOver(home, g3.backend);
    third.daemon.hydrate();
    await tick();
    expect(g3.prompts).toEqual([]);
    const states = third.events.filter((e) => e.type === 'chat.state' && e.chatId === chatId);
    expect(states.at(-1)).toMatchObject({ activity: 'idle', interrupted: true });
    // The line in the chat is said once, not once per restart.
    const lines = (h: typeof second): number =>
      h.events.filter(
        (e) =>
          e.type === 'chat.message' &&
          e.role === 'system' &&
          e.content === 'Turn interrupted by restart',
      ).length;
    expect(lines(second)).toBe(1);
    expect(lines(third)).toBe(0);
  });

  // A turn parked for a stated rate limit closes its failed attempt with
  // outcome `failed`, never `completed`/`stopped` — the settled-head check
  // above must not mistake "legitimately still owed, waiting on a retry" for
  // "already finished".
  it('does not misclassify an hours-old credit park as interrupted by a restart', async () => {
    const { home, folder } = setup();
    const metaStore = createMetaStore(home);
    const events: WireEvent[] = [];
    const RESETS_AT = 1_700_000_000_000 + 3_600_000;
    const rateLimited: SdkBackend = {
      run: async function* (): AsyncGenerator<never> {
        throw new TurnFailedError('rate limited', {
          kind: 'rate_limit',
          status: 'rejected',
          rateLimitType: 'seven_day',
          resetsAt: RESETS_AT,
        });
      },
    };
    const first = new Daemon({
      hostId: 'd1',
      metaStore,
      sdkBackend: rateLimited,
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'chat-1',
      accountLimitInfo: () => ({ label: 'Default', scope: 'week' as const, resetsAt: RESETS_AT }),
    });
    const chatId = await first.spawnChat({ folder });
    await first.sendInput({ chatId, message: 'go', localId: 'L1' });
    expect(pendingOf(metaStore, chatId).length).toBe(1);
    first.shutdown();

    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate({ deferWorkUntilReconciled: true });
    await tick();

    // Startup inventory has not been reconciled yet: nothing restarts in the
    // window where the server may still retire a chat moved to another host.
    expect(g2.prompts).toEqual([]);
    second.daemon.resumeAfterReconciliation();
    await tick();

    // Still owed, but the restart did not interrupt it. It remains parked until
    // account-credit state explicitly releases it.
    expect(g2.prompts).toEqual([]);
    expect(pendingOf(second.metaStore, chatId)).toEqual([
      expect.objectContaining({ message: 'go', waitingFor: 'credit' }),
    ]);
    expect(second.daemon.resumeAllRateLimited()).toBe(1);
    await tick();
    expect(g2.prompts).toEqual(['go']);
    await g2.drain();
  });

  it('does not retry a legacy failed park that predates persisted wait reasons', async () => {
    const { home, folder } = setup();
    const metaStore = createMetaStore(home);
    const failed: SdkBackend = {
      run: async function* (): AsyncGenerator<never> {
        throw new TurnFailedError("You've hit your session limit · resets 3pm (UTC)", {
          kind: 'rate_limit',
        });
      },
    };
    const first = new Daemon({
      hostId: 'd1',
      metaStore,
      sdkBackend: failed,
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'chat-1',
    });
    const chatId = await first.spawnChat({ folder });
    await first.sendInput({ chatId, message: 'go', localId: 'L1' });
    first.shutdown();

    // Reproduce the on-disk shape written by an older daemon: it recorded the
    // failed attempt as owed but had no field explaining that it was parked.
    metaStore.update(chatId, (m) => ({
      ...m,
      pendingTurns: (m.pendingTurns ?? []).map(({ waitingFor: _waitingFor, ...turn }) => turn),
    }));

    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    expect(g2.prompts).toEqual([]);
    expect(pendingOf(second.metaStore, chatId)).toEqual([]);
  });

  // A transient SDK failure parks the turn for a 10s/30s/90s retry. A reboot
  // that lands inside that window used to leave the chat errored for good
  // ("expired transient retry left failed") — the turn was still owed, so the
  // next host must run it. It never ran to completion, so it goes back
  // verbatim rather than with the "you were cut off" framing.
  it('re-sends a turn that was waiting out a transient retry when the host went down', async () => {
    const { home, folder } = setup();
    const metaStore = createMetaStore(home);
    const flaky: SdkBackend = {
      run: async function* (): AsyncGenerator<never> {
        throw new Error('socket hang up');
      },
    };
    const first = new Daemon({
      hostId: 'd1',
      metaStore,
      sdkBackend: flaky,
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'chat-1',
    });
    const chatId = await first.spawnChat({ folder });
    await first.sendInput({ chatId, message: 'go', localId: 'L1' });
    expect(pendingOf(metaStore, chatId)).toEqual([
      expect.objectContaining({ message: 'go', waitingFor: 'retry' }),
    ]);
    first.shutdown();

    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    expect(g2.prompts).toEqual(['go']);
    await g2.drain();
  });

  it('a cancelled queued turn stops being owed', async () => {
    const g = gatedBackend();
    const { home, folder } = setup();
    const { daemon, metaStore } = hostOver(home, g.backend);
    const chatId = await chatWithHistory(daemon, folder, g);

    void daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'doomed', localId: 'L2' });
    await tick();
    daemon.unqueueInput(chatId, 'L2');

    expect(pendingOf(metaStore, chatId)).toEqual([
      { message: 'running', localId: 'L1', retryOfSeq: 2 },
    ]);
  });

  it('hydrate does not re-send the cut-off turn: it is interrupted, and queued turns go back verbatim', async () => {
    const g1 = gatedBackend();
    const { home, folder } = setup();
    const first = hostOver(home, g1.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g1);

    void first.daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    void first.daemon.sendInput({ chatId, message: 'queued-a', localId: 'L2' });
    await tick();

    // …and the host is killed here — no finally, no drain, nothing cleared.
    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    // The turn that was mid-flight is NOT sent again, with a hidden reminder or
    // without one (spec/12 § Continue). The one queued behind it never began, so
    // it goes out as it was.
    expect(g2.prompts).toEqual(['queued-a']);
    expect(g2.prompts.join('')).not.toContain('system-reminder');
    await g2.drain();
    expect(pendingOf(second.metaStore, chatId)).toEqual([]);
  });

  // spec/12 § Continue — Interrupted is reported to the server as a host fact on
  // `chat.state`, and Continue is an ordinary visible message.
  it('shows an interrupted turn as such, and Continue sends one visible message', async () => {
    const g1 = gatedBackend();
    const { home, folder } = setup();
    const first = hostOver(home, g1.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g1);
    void first.daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();

    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    expect(g2.prompts).toEqual([]);
    const stateOf = () =>
      second.events.filter((e) => e.type === 'chat.state' && e.chatId === chatId).at(-1);
    expect(stateOf()).toMatchObject({ activity: 'idle', interrupted: true });
    expect(
      second.events.filter((e) => e.type === 'chat.message' && e.role === 'user'),
    ).toHaveLength(0);

    expect(await second.daemon.continueChat(chatId)).toBe(true);
    await tick();
    // The same Claude session carries on, with nothing added to the turn unseen.
    expect(g2.prompts).toEqual([CONTINUE_MESSAGE]);
    expect(second.daemon.chatState.get(chatId)?.claudeSessionId).toBe('sess');
    const sent = second.events.filter(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toBe(CONTINUE_MESSAGE);
    expect(sent[0]!.systemContext).toBeUndefined();
    expect(sent[0]!.retryOfSeq).toBeUndefined();
    expect(stateOf()).toMatchObject({ activity: 'running' });
    expect(stateOf()).not.toHaveProperty('interrupted');
    expect(second.metaStore.read(chatId)?.interrupted).toBeUndefined();

    // A second Continue (another surface pressed it too) does nothing.
    expect(await second.daemon.continueChat(chatId)).toBe(false);
    await g2.drain();
    expect(g2.prompts).toEqual([CONTINUE_MESSAGE]);
  });

  it('Continue on a chat that was never interrupted does nothing', async () => {
    const g = gatedBackend();
    const { home, folder } = setup();
    const first = hostOver(home, g.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g);
    expect(await first.daemon.continueChat(chatId)).toBe(false);
    await tick();
    expect(g.prompts).toEqual(['first']);
  });

  it('drops the interrupted turns of a chat that was deleted meanwhile', async () => {
    const g1 = gatedBackend();
    const { home, folder } = setup();
    const first = hostOver(home, g1.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g1);
    void first.daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    // Deleting stops the chat's work, and this backend never honours an abort (it
    // models a host that dies mid-turn), so the stop is left pending: what the
    // restart sees is the deleted status, which is persisted first.
    void first.daemon.setDeleted(chatId, true);
    await tick();

    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    expect(g2.prompts).toEqual([]);
    expect(pendingOf(second.metaStore, chatId)).toEqual([]);
  });

  it('shows a chat cut off with no owed turn as interrupted, not idle (done)', async () => {
    const g1 = gatedBackend();
    const { home, folder } = setup();
    const first = hostOver(home, g1.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g1);
    void first.daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    // The turn is open in the log but nothing records it as owed.
    first.metaStore.update(chatId, (m) => ({ ...m, pendingTurns: [] }));

    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    expect(g2.prompts).toEqual([]);
    const states = second.events.filter((e) => e.type === 'chat.state' && e.chatId === chatId);
    expect(states.at(-1)).toMatchObject({ activity: 'idle', interrupted: true });
    expect(second.metaStore.read(chatId)?.lastError ?? null).toBeNull();
  });

  it('a chat that was idle at the restart is not given a turn it never had', async () => {
    const g1 = gatedBackend();
    const { home, folder } = setup();
    const first = hostOver(home, g1.backend);
    await chatWithHistory(first.daemon, folder, g1);

    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    expect(g2.prompts).toEqual([]);
  });
});

// pendingDecisions.ts: a permission/AskUserQuestion blocks the turn inside the
// SDK's canUseTool callback via an in-memory Promise (permissionGates) that
// cannot survive a restart — unlike the `gatedBackend()` cases above, which
// model an ordinary in-flight turn, this models the host dying while
// blocked on a HUMAN decision specifically, which is a much longer and more
// common wait (up to the 1h approval timeout, or unbounded for a question with
// expiry turned off) than a turn merely mid-tool-execution.
describe('a turn cut off while awaiting a permission/question decision', () => {
  it('is interrupted like any other cut-off turn, adds nothing hidden, and clears the persisted record', async () => {
    const { home, folder } = setup();
    const metaStore = createMetaStore(home);
    const events: WireEvent[] = [];
    let id = 0;
    const first = new Daemon({
      hostId: 'd1',
      metaStore,
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
      permissionModeDefault: 'plan',
    });
    const chatId = await first.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await tick();
    expect(first.chatState.get(chatId)?.activity).toBe('awaiting-permission');

    const chatDir = dirname(metaStore.pathFor(chatId));
    const decisionsFile = join(chatDir, 'pending-decisions.json');
    expect(existsSync(decisionsFile)).toBe(true);

    // Killed here — no answer was ever given.
    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    // Nothing is sent, and nothing about the question reaches the agent as
    // hidden text: the user continues, and the agent is told in a visible
    // message like any other.
    expect(g2.prompts).toEqual([]);
    expect(
      second.events.filter((e) => e.type === 'chat.state' && e.chatId === chatId).at(-1),
    ).toMatchObject({ interrupted: true });
    // The answer died with the process; a stale record would only mislead a later restart.
    expect(existsSync(decisionsFile)).toBe(false);
  });

  it('a decision answered before the restart leaves nothing to resume specially', async () => {
    const { home, folder } = setup();
    const metaStore = createMetaStore(home);
    const events: WireEvent[] = [];
    let id = 0;
    const first = new Daemon({
      hostId: 'd1',
      metaStore,
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
      permissionModeDefault: 'plan',
    });
    const chatId = await first.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await tick();
    const req = events.find((e) => e.type === 'chat.permission_request') as
      | { requestId: string }
      | undefined;
    expect(req).toBeDefined();
    first.submitPermissionResponse({ requestId: req!.requestId, decision: 'approve' });
    await tick();

    // Answered and settled in the SAME process — the ordinary, overwhelmingly
    // common case. Nothing should be left on disk for a restart to trip over.
    const chatDir = dirname(metaStore.pathFor(chatId));
    expect(existsSync(join(chatDir, 'pending-decisions.json'))).toBe(false);

    const g2 = gatedBackend();
    const second = hostOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();
    expect(g2.prompts).toEqual([]);
  });

  // Patch's own log is the record; the provider session is only a cache of it.
  // A restart must hand the model the whole conversation whether or not a native
  // session survives — not a contextless session that sees only "Carry on".
  describe('rebuilds the model context from the chat log', () => {
    type Opts = Parameters<SdkBackend['run']>[0];

    /** Records every run's options and holds each turn open until released. */
    function recordingBackend(sessionId: string | null) {
      const gates: Array<() => void> = [];
      const runs: Opts[] = [];
      const backend: SdkBackend = {
        async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
          runs.push(opts);
          await new Promise<void>((resolve) => gates.push(resolve));
          if (sessionId) yield { type: 'result', sessionId };
          yield {
            type: 'assistant',
            content: `reply:${opts.prompt}`,
            ...(sessionId ? { sessionId } : {}),
          };
        },
      };
      return {
        backend,
        runs,
        release: (): void => void gates.shift()?.(),
        drain: async (): Promise<void> => {
          for (let i = 0; i < 10; i++) {
            while (gates.length > 0) gates.shift()?.();
            await tick();
          }
        },
      };
    }

    const reseedOf = (o: Opts) =>
      transcriptFor(o)
        .filter((e) => e.type === 'user' || e.type === 'assistant')
        .map((e) => ({ event: { role: e.message?.role ?? '', content: entryText(e) } }));
    // System lines (e.g. the 'host restarted' note) are in the track but dropped
    // by the reconstruction, so the model never receives them.
    const reseededTexts = (o: Opts): string[] =>
      reseedOf(o)
        .filter((t) => t.event.role !== 'system')
        .map((t) => t.event.content);

    function hostWith(home: string, backend: SdkBackend, extra: Record<string, unknown> = {}) {
      const metaStore = createMetaStore(home);
      let id = 0;
      const daemon = new Daemon({
        hostId: 'd1',
        metaStore,
        sdkBackend: backend,
        oauthAccessToken: 'fake-token',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => `chat-${++id}`,
        ...extra,
      } as ConstructorParameters<typeof Daemon>[0]);
      return { daemon, metaStore };
    }

    it('first-turn interruption: nothing was answered, so the owed turn restarts as a fresh session with no reseed', async () => {
      const r1 = recordingBackend(null);
      const { home, folder } = setup();
      const first = hostWith(home, r1.backend);
      const chatId = await first.daemon.spawnChat({ folder });
      void first.daemon.sendInput({
        chatId,
        message: 'Autonomous job. Do not ask questions.',
        localId: 'L1',
      });
      await tick();
      expect(first.daemon.chatState.get(chatId)?.claudeSessionId).toBeUndefined();

      const r2 = recordingBackend('sess-2');
      const second = hostWith(home, r2.backend);
      second.daemon.hydrate();
      await tick();
      await second.daemon.continueChat(chatId);
      await tick();

      expect(r2.runs).toHaveLength(1);
      expect(r2.runs[0]!.prompt).toBe(CONTINUE_MESSAGE);
      // Nothing was answered, so there is no conversation to carry: Claude Code
      // would refuse an empty transcript ("No conversation found").
      expect(r2.runs[0]!.resumeSessionId).toBeUndefined();
      expect(reseededTexts(r2.runs[0]!)).toEqual([]);
      await r2.drain();
    });

    it('repeated reboot: the chat stays interrupted, and Continue carries the full history', async () => {
      const r1 = recordingBackend(null);
      const { home, folder } = setup();
      const first = hostWith(home, r1.backend);
      const chatId = await first.daemon.spawnChat({ folder });
      void first.daemon.sendInput({ chatId, message: 'original ask', localId: 'L1' });
      await tick();

      // Reboot 1 (no id yet): nothing is sent.
      const r2 = recordingBackend(null);
      hostWith(home, r2.backend).daemon.hydrate();
      await tick();
      expect(r2.runs).toEqual([]);

      // Reboot 2: still interrupted; Continue now.
      const r3 = recordingBackend('sess-3');
      const third = hostWith(home, r3.backend);
      third.daemon.hydrate();
      await tick();
      expect(r3.runs).toEqual([]);
      await third.daemon.continueChat(chatId);
      await tick();
      expect(r3.runs).toHaveLength(1);
      expect(r3.runs[0]!.resumeSessionId).toBeUndefined();
      expect(reseededTexts(r3.runs[0]!)).toEqual([]);
      expect(r3.runs[0]!.prompt).toBe(CONTINUE_MESSAGE);
      await r3.drain();

      // Reboot 3, after the turn settled: a plain resume with nothing pending.
      const r4 = recordingBackend('sess-3');
      hostWith(home, r4.backend).daemon.hydrate();
      await tick();
      expect(r4.runs).toEqual([]);
    });

    it('missing native transcript: a session id with no transcript on disk is rebuilt from the log', async () => {
      const g1 = recordingBackend('sess-old');
      const { home, folder } = setup();
      const first = hostWith(home, g1.backend);
      const chatId = await first.daemon.spawnChat({ folder });
      void first.daemon.sendInput({ chatId, message: 'turn one', localId: 'L0' });
      await tick();
      g1.release();
      await tick();
      void first.daemon.sendInput({ chatId, message: 'turn two', localId: 'L1' });
      await tick();
      expect(first.daemon.chatState.get(chatId)?.claudeSessionId).toBe('sess-old');

      // 'real' kind: sess-old has no <id>.jsonl under the claude projects dir.
      const g2 = recordingBackend('sess-new');
      const second = hostWith(home, g2.backend, { sdkBackendKind: 'real' });
      second.daemon.hydrate();
      await tick();
      await second.daemon.continueChat(chatId);
      await tick();

      expect(g2.runs).toHaveLength(1);
      expect(g2.runs[0]!.resumeSessionId).not.toBe('sess-old');
      const texts = reseededTexts(g2.runs[0]!);
      expect(texts).toContain('turn one');
      expect(texts).toContain('reply:turn one');
      expect(texts).toContain('turn two');
      await g2.drain();
    });

    it('provider switch: a restart onto a Codex model rebuilds the Codex thread from the same log', async () => {
      const g1 = recordingBackend('sess-claude');
      const { home, folder } = setup();
      const first = hostWith(home, g1.backend);
      const chatId = await first.daemon.spawnChat({ folder });
      void first.daemon.sendInput({ chatId, message: 'turn one', localId: 'L0' });
      await tick();
      g1.release();
      await tick();
      void first.daemon.sendInput({ chatId, message: 'turn two', localId: 'L1' });
      await tick();
      // The model moved to another provider while the host was down.
      first.metaStore.update(chatId, (m) => ({ ...m, model: 'openai/gpt-5.5' }));

      const g2 = recordingBackend(null);
      const second = hostWith(home, g2.backend, {
        knownModelIds: undefined,
      });
      second.daemon.hydrate();
      await tick();
      await second.daemon.continueChat(chatId);
      await tick();

      expect(g2.runs).toHaveLength(1);
      const events = (g2.runs[0]!.codexReseed ?? g2.runs[0]!.codexAppendItems)?.events ?? [];
      const texts = events
        .filter((t) => t.event.type === 'chat.message')
        .map((t) => (t.event as { content: string }).content);
      expect(texts).toContain('turn one');
      expect(texts).toContain('turn two');
      await g2.drain();
    });
  });
});

describe('a restart says so in the chat', () => {
  it('records a system line when a turn is found interrupted', async () => {
    const g = gatedBackend();
    const { home, folder } = setup();
    const first = hostOver(home, g.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g);
    void first.daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();

    const second = hostOver(home, createMockSdkBackend());
    second.daemon.hydrate();
    await tick(50);

    const lines = second.events.filter(
      (e) =>
        e.type === 'chat.message' &&
        e.role === 'system' &&
        e.content === 'Turn interrupted by restart',
    );
    expect(lines).toHaveLength(1);
  });

  it('says the turn was interrupted once, and the Continue message follows it as its own message', async () => {
    const g = gatedBackend();
    const { home, folder } = setup();
    const first = hostOver(home, g.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g);
    void first.daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();

    const second = hostOver(home, createMockSdkBackend());
    second.daemon.hydrate();
    await tick(50);
    await second.daemon.continueChat(chatId);
    await tick(50);

    const replayed: WireEvent[] = [];
    second.daemon.replayChat(chatId, 0, (ev) => replayed.push(ev));
    const order = replayed
      .filter((e) => e.type === 'chat.message')
      .map((e) => `${(e as { role: string }).role}:${(e as { content: string }).content}`);
    const marker = order.indexOf('system:Turn interrupted by restart');
    expect(marker).toBeGreaterThan(-1);
    expect(order[marker + 1]).toBe(`user:${CONTINUE_MESSAGE}`);
  });
});
