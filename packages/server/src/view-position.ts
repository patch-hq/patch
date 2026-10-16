// Server-owned view position (spec/05 § Handover): the page and scroll
// position the user was last on, on whichever surface reported it, so another
// surface can pick up where they left off. One account-wide entry, persisted
// to `<dataDir>/view-position.json` (atomic write). It is re-derivable state:
// a corrupt file is logged loudly and read as empty, never thrown.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { ViewPage } from '@patch/wire';

export interface ViewPosition {
  page: ViewPage;
  id?: string;
  seq?: number;
  surfaceId: string;
  updatedAt: number;
}

export class ViewPositionStore {
  private readonly path: string | null;
  private readonly logger: Pick<Logger, 'warn'> | undefined;
  private readonly nowMs: () => number;
  private current: ViewPosition | null;
  private readonly handlers = new Set<(p: ViewPosition) => void>();

  constructor(opts: { dataDir?: string; logger?: Pick<Logger, 'warn'>; nowMs?: () => number }) {
    this.path = opts.dataDir ? join(opts.dataDir, 'view-position.json') : null;
    this.logger = opts.logger;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
    this.current = this.load();
  }

  private load(): ViewPosition | null {
    if (!this.path || !existsSync(this.path)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      const page = ViewPage.safeParse((raw as { page?: unknown } | null)?.page);
      const r = raw as Partial<ViewPosition>;
      if (!page.success || typeof r.surfaceId !== 'string' || typeof r.updatedAt !== 'number') {
        throw new Error('malformed');
      }
      return {
        page: page.data,
        ...(typeof r.id === 'string' ? { id: r.id } : {}),
        ...(typeof r.seq === 'number' ? { seq: r.seq } : {}),
        surfaceId: r.surfaceId,
        updatedAt: r.updatedAt,
      };
    } catch (err) {
      this.logger?.warn(
        { path: this.path, err: (err as Error).message },
        'view-position: unreadable file; starting empty',
      );
      return null;
    }
  }

  get(): ViewPosition | null {
    return this.current;
  }

  set(surfaceId: string, pos: { page: ViewPage; id?: string; seq?: number }): void {
    const next: ViewPosition = {
      page: pos.page,
      ...(pos.id !== undefined ? { id: pos.id } : {}),
      ...(pos.seq !== undefined ? { seq: pos.seq } : {}),
      surfaceId,
      updatedAt: this.nowMs(),
    };
    this.current = next;
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmp, this.path);
    }
    for (const h of this.handlers) {
      try {
        h(next);
      } catch (err) {
        this.logger?.warn({ err: (err as Error).message }, 'view-position: handler threw');
      }
    }
  }

  onChange(handler: (p: ViewPosition) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
