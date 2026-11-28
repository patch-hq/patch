// Changing the Manager's home host (spec/06 § Changing home).
//
// The user chooses the home; it never moves by itself. A change is a visible
// handover: the new home continues every special thread's record from the
// server's high-water mark for it (Speakers as well as the Manager), and the thread's recent conversation reaches its fresh
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
  log: Pick<ChatLogStore, 'read' | 'highWater'>;
  /** How many messages of the conversation the draft carries. */
  contextWindow: () => number;
  sendTo: (hostId: string, surfaceId: string, event: WireEvent) => void;
  registeredHostIds: () => string[];
  /** Tell every surface the roster changed. */
  onChanged: () => void;
  /** The Manager folder (`''` is the default). */
  currentFolder?: () => string;
  /** Put the Manager folder back to the default: a folder is a path on one host. */
  resetFolder?: () => void;
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
    const nextSeqs: Record<string, number> = {};
    for (const chatId of Object.values(SPECIAL_THREAD_IDS)) {
      nextSeqs[chatId] = this.deps.log.highWater(chatId) + 1;
    }
    const folder = this.deps.currentFolder?.() ?? '';
    this.deps.registry.changeManagerHome(toHostId, {
      nextSeqs,
      fromHostName: this.deps.registry.hostName(from) ?? from,
      toHostName: this.deps.registry.hostName(toHostId) ?? toHostId,
      message,
      ...(folder !== '' ? { folderReset: folder } : {}),
    });
    const setManager: WireEvent = { type: 'host.set_manager', hostId: toHostId };
    // The old home stops running the Manager before the folder goes back to
    // the default, so it never moves its copy on the way out; the new home
    // starts running it after, so it is never given the old home's path.
    for (const id of this.deps.registeredHostIds()) {
      if (id !== toHostId) this.deps.sendTo(id, SERVER_SURFACE, setManager);
    }
    if (folder !== '') this.deps.resetFolder?.();
    if (this.deps.registeredHostIds().includes(toHostId)) {
      this.deps.sendTo(toHostId, SERVER_SURFACE, setManager);
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
      nextSeq: h.nextSeqs[SPECIAL_THREAD_IDS.manager] ?? 0,
      nextSeqs: h.nextSeqs,
      fromHostName: h.fromHostName,
      toHostName: h.toHostName,
      message: h.message,
      ...(h.folderReset !== undefined ? { folderReset: h.folderReset } : {}),
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
