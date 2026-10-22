// Server-owned draft ATTACHMENTS (spec/14 & spec/15 § Composer → Attachments).
//
// The files attached to an unsent draft — an existing chat's composer, or a
// not-yet-spawned new-chat draft — keyed by the draft's key (a chatId, or a
// new-chat draft's own id). Held apart from the draft TEXT stores on purpose:
// text and attachments are independent axes (a user who deletes what they
// typed but not the file they attached keeps the file), each with its own
// newest-write-wins clock, and keeping them in their own file leaves the text
// stores' on-disk shape and wire events exactly as they were.
//
// The store only ever holds the small `DraftAttachmentRef` (id/name/mimeType/
// kind/url), the same shape that rides the wire. It never touches attachment
// BYTES — that is the route layer's job (`attachments.ts`), which alone knows
// the directories and the host link.
//
// Persisted as `<dataDir>/<fileName>`, written atomically (temp file +
// rename). A corrupt file is logged loudly and the store starts empty;
// `dataDir` is optional (a bare-registry test): in memory only then.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { DraftAttachmentRef } from '@patch/wire';
import { parsePersisted } from './persisted-json.js';

export interface DraftAttachmentsEntry {
  key: string;
  attachments: DraftAttachmentRef[];
  updatedAt: number;
}

export type DraftAttachmentsChange = DraftAttachmentsEntry;

interface Stored {
  attachments: DraftAttachmentRef[];
  updatedAt: number;
}

export class DraftAttachmentStore {
  private readonly path: string | null;
  private readonly label: string;
  private readonly logger: Pick<Logger, 'warn'> | undefined;
  private readonly nowMs: () => number;
  private entries: Record<string, Stored>;
  private readonly handlers = new Set<(change: DraftAttachmentsChange) => void>();

  constructor(opts: {
    /** File name under `dataDir`, e.g. `composer-draft-attachments.json`. */
    fileName: string;
    dataDir?: string;
    logger?: Pick<Logger, 'warn'>;
    nowMs?: () => number;
  }) {
    this.path = opts.dataDir ? join(opts.dataDir, opts.fileName) : null;
    this.label = opts.fileName;
    this.logger = opts.logger;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
    this.entries = this.load();
  }

  private load(): Record<string, Stored> {
    if (!this.path || !existsSync(this.path)) return {};
    let raw: unknown;
    try {
      raw = parsePersisted(readFileSync(this.path, 'utf8'));
    } catch (err) {
      this.logger?.warn(
        { path: this.path, err: (err as Error).message },
        `${this.label}: unreadable file; starting empty`,
      );
      return {};
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      this.logger?.warn({ path: this.path }, `${this.label}: malformed file; starting empty`);
      return {};
    }
    const out: Record<string, Stored> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const e = value as Partial<Stored> | null;
      if (typeof e !== 'object' || e === null || typeof e.updatedAt !== 'number') continue;
      const parsed = DraftAttachmentRef.array().safeParse(e.attachments);
      if (!parsed.success || parsed.data.length === 0) continue;
      out[key] = { attachments: parsed.data, updatedAt: e.updatedAt };
    }
    return out;
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  /** Every key that holds attachments — the cold-start snapshot. */
  list(): DraftAttachmentsEntry[] {
    return Object.entries(this.entries).map(([key, e]) => ({ key, ...e }));
  }

  /** The attachments `key` currently holds (empty when none). */
  get(key: string): DraftAttachmentRef[] {
    return this.entries[key]?.attachments ?? [];
  }

  /**
   * Replace `key`'s attachment list outright. The route layer computes the new
   * full list (add: append one; remove: filter one out) and hands it over
   * whole, the same way `*.attachments_changed` rides the whole list rather
   * than a delta. An empty list drops the key. Always emits, even when the
   * list is unchanged, so every surface converges on it.
   */
  set(key: string, attachments: DraftAttachmentRef[]): void {
    const updatedAt = this.nowMs();
    if (attachments.length === 0) {
      if (key in this.entries) {
        const next = { ...this.entries };
        delete next[key];
        this.entries = next;
        this.persist();
      }
    } else {
      this.entries = { ...this.entries, [key]: { attachments, updatedAt } };
      this.persist();
    }
    for (const h of this.handlers) {
      try {
        h({ key, attachments, updatedAt });
      } catch (err) {
        this.logger?.warn({ err: (err as Error).message }, `${this.label}: change handler threw`);
      }
    }
  }

  onChange(handler: (change: DraftAttachmentsChange) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
