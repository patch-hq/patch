// spec/06 § Where special threads run, § Changing home — the Manager's home is
// the user's choice, never moved by the server, and changing it is a handover.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { generateUserKeypair } from '@patch/auth';
import { ManagerHome, ManagerHomeError } from '../src/manager-home.js';
import { Registry } from '../src/registry.js';
import { ChatLogStore } from '../src/chat-log-store.js';

const KP = generateUserKeypair(() => new Uint8Array(32).fill(1));
const say = (
  seq: number,
  role: 'user' | 'assistant' | 'system',
  content: string,
  chatId = 'thread_manager',
): WireEvent => ({ type: 'chat.message', chatId, role, content, seq }) as WireEvent;

describe('ManagerHome', () => {
  let dir: string;
  let registry: Registry;
  let sent: Array<[string, WireEvent]>;
  let changed: number;
  let events: WireEvent[];
  let home: ManagerHome;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manager-home-'));
    registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: KP });
    sent = [];
    changed = 0;
    events = [];
    home = new ManagerHome({
      registry,
      log: {
        read: (_id: string, from: number) =>
          events.filter((e) => (e as { seq: number }).seq > from),
        highWater: (id: string) =>
          Math.max(
            -1,
            ...events
              .filter((e) => (e as { chatId: string }).chatId === id)
              .map((e) => (e as { seq: number }).seq),
          ),
      } as never,
      contextWindow: () => 2,
      sendTo: (hostId, _surface, event) => sent.push([hostId, event]),
      registeredHostIds: () => registry.registeredHostIds(),
      onChanged: () => changed++,
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function twoHosts(): void {
    registry.setDaemonKey({ hostId: 'h1', publicKey: KP.publicKey, issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'h2', publicKey: KP.publicKey, issuedAt: 1 });
    registry.setHostName('h1', 'Laptop');
    registry.setHostName('h2', 'Server');
  }

  it('the registry stays where the user put it: nothing moves the Manager by itself', () => {
    twoHosts();
    expect(home.current()).toBe('h1');
    expect(registry.managerHandover()).toBeNull();
  });

  it('refuses an unknown host and the host that is already home', () => {
    twoHosts();
    expect(() => home.change('nope', '')).toThrow(ManagerHomeError);
    expect(() => home.change('h1', '')).toThrow(/already/);
    expect(sent).toEqual([]);
  });

  it('drafts the recent conversation, leaving out system lines', () => {
    twoHosts();
    events = [
      say(0, 'user', 'one'),
      say(1, 'system', 'divider'),
      say(2, 'assistant', 'two'),
      say(3, 'user', 'three'),
    ];
    const draft = home.draft('h2');
    expect(draft).toContain('assistant: two');
    expect(draft).toContain('user: three');
    expect(draft).not.toContain('one');
    expect(draft).not.toContain('divider');
  });

  it('drafts nothing for a Manager that has said nothing', () => {
    twoHosts();
    expect(home.draft('h2')).toBe('');
  });

  it('a change tells every host who is home and the new home to continue after the stored record', () => {
    twoHosts();
    events = [
      say(0, 'user', 'a'),
      say(7, 'assistant', 'b'),
      say(3, 'assistant', 's', 'thread_speakers'),
    ];
    home.change('h2', 'summary the user approved');
    expect(home.current()).toBe('h2');
    expect(
      sent
        .filter(([, e]) => e.type === 'host.set_manager')
        .map(([h]) => h)
        .sort(),
    ).toEqual(['h1', 'h2']);
    const handover = sent.find(([, e]) => e.type === 'host.manager_handover');
    expect(handover?.[0]).toBe('h2');
    expect(handover?.[1]).toMatchObject({
      hostId: 'h2',
      epoch: 1,
      nextSeq: 8,
      nextSeqs: { thread_manager: 8, thread_speakers: 4 },
      fromHostName: 'Laptop',
      toHostName: 'Server',
      message: 'summary the user approved',
    });
    expect(changed).toBe(1);
  });

  it('a new home that was offline is told again when it attaches, and the old home is not', () => {
    twoHosts();
    home.change('h2', '');
    expect(home.pendingFor('h2')).toMatchObject({ type: 'host.manager_handover', epoch: 1 });
    expect(home.pendingFor('h1')).toBeNull();
    home.change('h1', '');
    expect(home.pendingFor('h2')).toBeNull();
    expect(home.pendingFor('h1')).toMatchObject({ epoch: 2 });
  });

  it('survives a restart', () => {
    twoHosts();
    home.change('h2', 'm');
    const reloaded = Registry.load(dir);
    expect(reloaded.managerHostId()).toBe('h2');
    expect(reloaded.managerHandover()).toMatchObject({ epoch: 1, message: 'm' });
  });

  it('reads a handover recorded before Speakers was handed over', () => {
    twoHosts();
    home.change('h2', 'm');
    const file = join(dir, 'registry.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    delete raw.managerHandover.nextSeqs;
    raw.managerHandover.nextSeq = 5;
    writeFileSync(file, JSON.stringify(raw));
    expect(Registry.load(dir).managerHandover()).toMatchObject({
      nextSeqs: { thread_manager: 5 },
    });
  });
});

describe('ManagerHome with the real record: Speakers after a change of home', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('the new home’s Speakers entries are kept, in order, with no gap or duplicate', () => {
    dir = mkdtempSync(join(tmpdir(), 'manager-home-speakers-'));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: KP });
    registry.setDaemonKey({ hostId: 'h1', publicKey: KP.publicKey, issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'h2', publicKey: KP.publicKey, issuedAt: 1 });
    const log = new ChatLogStore({ dataDir: dir, logger: { warn: () => {} } });
    const speakers = (seq: number, content: string): WireEvent =>
      say(seq, 'assistant', content, 'thread_speakers');
    // The old home said six things in Speakers and one to the Manager.
    for (let seq = 0; seq < 6; seq++) expect(log.commit(speakers(seq, `old ${seq}`))).toBe('new');
    log.commit(say(0, 'user', 'hello'));

    const sent: WireEvent[] = [];
    const home = new ManagerHome({
      registry,
      log,
      contextWindow: () => 2,
      sendTo: (_h, _s, e) => sent.push(e),
      registeredHostIds: () => registry.registeredHostIds(),
      onChanged: () => {},
    });
    home.change('h2', '');
    const handover = sent.find((e) => e.type === 'host.manager_handover') as {
      nextSeqs: Record<string, number>;
    };

    // The new home numbers its Speakers entries from where the handover says.
    let next = handover.nextSeqs['thread_speakers']!;
    for (const content of ['new a', 'new b', 'new c']) {
      expect(log.commit(speakers(next++, content))).toBe('new');
    }
    const held = log
      .read('thread_speakers', -1)
      .map((e) => [(e as { seq: number }).seq, (e as { content: string }).content]);
    expect(held).toEqual([
      ...[0, 1, 2, 3, 4, 5].map((s) => [s, `old ${s}`]),
      [6, 'new a'],
      [7, 'new b'],
      [8, 'new c'],
    ]);
  });
});
