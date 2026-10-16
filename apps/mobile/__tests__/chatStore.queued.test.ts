// spec/04 ## Message queueing — the mobile store's side of the queue: the same
// chat.queued / chat.dequeued handling as web's chatStore.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';

const tl = (): NonNullable<ReturnType<typeof useChatStore.getState>['timelines'][string]> =>
  useChatStore.getState().timelines['c1'] ?? [];

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('chat.queued', () => {
  it('flags the optimistic echo as queued and clears its delivery marks', () => {
    const s = useChatStore.getState();
    s.appendLocalUserMessage('c1', 'next please', 'L1');
    expect(tl()[0]?.deliveryPending).toBe(true);
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'L1',
      message: 'next please',
      queueSeq: 1,
    });
    expect(tl()).toHaveLength(1);
    expect(tl()[0]).toMatchObject({ queued: true, deliveryPending: false, deliveryFailed: false });
  });

  it('a chat.queued arriving after the persisted echo adds no second QUEUED bubble', () => {
    const s = useChatStore.getState();
    s.appendLocalUserMessage('c1', 'stuck screw', 'L9');
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 3,
      role: 'user',
      content: 'stuck screw',
      localId: 'L9',
    });
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'L9',
      message: 'stuck screw',
      queueSeq: 1,
    });
    expect(tl()).toHaveLength(1);
    expect(tl()[0]?.queued).toBeFalsy();
  });

  it('appends a turn queued from another surface', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'X',
      message: 'from desktop',
      queueSeq: 1,
    });
    expect(tl()[0]).toMatchObject({
      role: 'user',
      content: 'from desktop',
      localId: 'X',
      queued: true,
    });
  });

  it('a re-announce after an edit updates the text in place, keeping its place', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.queued', chatId: 'c1', localId: 'A', message: 'one', queueSeq: 1 });
    s.applyEvent({ type: 'chat.queued', chatId: 'c1', localId: 'B', message: 'two', queueSeq: 2 });
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'A',
      message: 'one edited',
      queueSeq: 1,
    });
    expect(tl().map((e) => e.content)).toEqual(['one edited', 'two']);
  });

  it('keeps queued turns below live output that arrives afterwards', () => {
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'A',
      message: 'queued',
      queueSeq: 1,
    });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 5,
      role: 'assistant',
      content: 'still going',
    });
    expect(tl().map((e) => e.content)).toEqual(['still going', 'queued']);
  });
});

describe('chat.dequeued', () => {
  it('running: the turn goes live (queued flag cleared, kept in place)', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.queued', chatId: 'c1', localId: 'A', message: 'one', queueSeq: 1 });
    s.applyEvent({ type: 'chat.dequeued', chatId: 'c1', localId: 'A', reason: 'running' });
    expect(tl()[0]?.queued).toBe(false);
  });

  it('cancelled: the entry is dropped', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.queued', chatId: 'c1', localId: 'A', message: 'one', queueSeq: 1 });
    s.applyEvent({ type: 'chat.dequeued', chatId: 'c1', localId: 'A', reason: 'cancelled' });
    expect(tl()).toHaveLength(0);
  });

  it('an unknown localId is a no-op', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.dequeued', chatId: 'c1', localId: 'nope', reason: 'cancelled' });
    expect(tl()).toHaveLength(0);
  });
});

describe('the persisted echo of a queued turn', () => {
  it('releases it from the queue when chat.dequeued was missed', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.queued', chatId: 'c1', localId: 'A', message: 'q', queueSeq: 1 });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 5,
      role: 'user',
      content: 'q',
      localId: 'A',
    } as never);
    s.applyEvent({ type: 'chat.message', chatId: 'c1', seq: 6, role: 'assistant', content: 'a' });
    expect(tl()[0]?.queued).toBe(false);
    expect(tl().map((e) => e.content)).toEqual(['q', 'a']);
  });
});

describe('removeQueued', () => {
  it('removes only a still-queued entry', () => {
    const s = useChatStore.getState();
    s.appendLocalUserMessage('c1', 'settled-ish', 'S');
    s.applyEvent({ type: 'chat.queued', chatId: 'c1', localId: 'A', message: 'one', queueSeq: 1 });
    s.removeQueued('c1', 'S'); // not queued → untouched
    s.removeQueued('c1', 'A');
    expect(tl().map((e) => e.localId)).toEqual(['S']);
  });
});

describe('chat.state idle', () => {
  it('releases queued turns whose chat.dequeued was missed', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.queued', chatId: 'c1', localId: 'A', message: 'one', queueSeq: 1 });
    expect(tl()[0]?.queued).toBe(true);
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      activity: 'idle',
      permissionMode: 'default',
      lastUpdated: Date.now() + 1000,
    } as never);
    expect(tl()[0]?.queued).toBe(false);
  });

  it('keeps queued turns below an artifact card that arrives afterwards', () => {
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'A',
      message: 'queued',
      queueSeq: 1,
    });
    s.applyEvent({
      type: 'chat.artifact',
      chatId: 'c1',
      seq: 7,
      artifactId: 'a1',
      title: 'Report',
      url: '/api/chats/c1/artifact/a1',
      path: 'out/report.html',
      updatedAt: 1,
    });
    expect(tl().map((e) => e.kind)).toEqual(['artifact', 'message']);
  });
});
