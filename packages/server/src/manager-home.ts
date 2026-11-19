// Changing the Manager's home host (spec/06 § Changing home).
//
// The user chooses the home; it never moves by itself. A change is a visible
// handover: the new home continues the thread's record from the server's
// highest stored `seq`, and the thread's recent conversation reaches its fresh
// provider session only as an ordinary message the user has seen and approved.

import { headCodePoints, tailCodePoints, SPECIAL_THREAD_IDS, type WireEvent } from '@patch/wire';
import type { ChatLogStore } from './chat-log-store.js';
import type { Registry } from './registry.js';
import { ManagerHomeError } from './manager-home-error.js';

export { ManagerHomeError };

const MESSAGE_CHARS = 2_000;
const SUMMARY_CHARS = 24_000;
const SERVER_SURFACE = '_server';

export interface ManagerHomeDeps {
  registry: Pick<
    Registry,
    'managerHostId' | 'isRegisteredHost' | 'hostName' | 'changeManagerHome' | 'managerHandover'
  >;
  log: Pick<ChatLogStore, 'read'>;
  /** How many messages of the conversation the draft carries. */
  contextWindow: () => number;
  sendTo: (hostId: string, surfaceId: string, event: WireEvent) => void;
  registeredHostIds: () => string[];
  /** Tell every surface the roster changed. */
  onChanged: () => void;
}

export class ManagerHome {
  constructor(private readonly deps: ManagerHomeDeps) {}

  current(): string | null {
    return this.deps.registry.managerHostId();
  }

  /** The summary the user is shown, and may edit or clear, before the change. */
  draft(toHostId: string): string {
    this.check(toHostId);
    const lines: string[] = [];
    for (const e of this.deps.log.read(SPECIAL_THREAD_IDS.manager, -1)) {
      if (e.type !== 'chat.message' || e.role === 'system') continue;
      lines.push(`${e.role}: ${headCodePoints(e.content, MESSAGE_CHARS)}`);
    }
    const recent = lines.slice(-this.deps.contextWindow());
    if (recent.length === 0) return '';
    const body = tailCodePoints(recent.join('\n\n'), SUMMARY_CHARS);
    return (
      `You are the Manager. You have moved to a new host, so your earlier session is not here. ` +
      `This is the recent conversation, oldest first, to carry on from:\n\n${body}`
    );
  }

  /** Make `toHostId` the home, with the user's approved `message` (empty to send none). */
  change(toHostId: string, message: string): void {
    const from = this.check(toHostId);
    const events = this.deps.log.read(SPECIAL_THREAD_IDS.manager, -1);
    const last = events.at(-1) as { seq: number } | undefined;
    this.deps.registry.changeManagerHome(toHostId, {
      nextSeq: last ? last.seq + 1 : 0,
      fromHostName: this.deps.registry.hostName(from) ?? from,
      toHostName: this.deps.registry.hostName(toHostId) ?? toHostId,
      message,
    });
    for (const id of this.deps.registeredHostIds()) {
      this.deps.sendTo(id, SERVER_SURFACE, { type: 'host.set_manager', hostId: toHostId });
    }
    this.deps.sendTo(toHostId, SERVER_SURFACE, this.event());
    this.deps.onChanged();
  }

  /** The handover a host is owed when it attaches, if it is the new home. */
  pendingFor(hostId: string): WireEvent | null {
    const h = this.deps.registry.managerHandover();
    return h && h.hostId === hostId && this.current() === hostId ? this.event() : null;
  }

  private event(): WireEvent {
    const h = this.deps.registry.managerHandover();
    if (!h) throw new Error('ManagerHome: no handover recorded');
    return {
      type: 'host.manager_handover',
      hostId: h.hostId,
      epoch: h.epoch,
      nextSeq: h.nextSeq,
      fromHostName: h.fromHostName,
      toHostName: h.toHostName,
      message: h.message,
    };
  }

  private check(toHostId: string): string {
    if (!this.deps.registry.isRegisteredHost(toHostId)) {
      throw new ManagerHomeError('unknown_host', `no host registered as ${toHostId}`);
    }
    const from = this.deps.registry.managerHostId();
    if (from === null) throw new ManagerHomeError('no_home', 'no host is registered yet');
    if (from === toHostId) {
      throw new ManagerHomeError('already_home', 'that host is already the Manager’s home');
    }
    return from;
  }
}
