// Views — lasting, reusable screens the agent keeps current (spec/14 § Views).
//
// A view is a template (which screen draws it) plus a data document the agent
// owns, and the user's marks on the document's items. The agent sends the whole
// document once and then only changes (JSON Patch), each change bumping `rev`;
// every surface reads the same state. Marks are the user's: a yes/no verdict
// and a note per item id, kept until the agent removes the item.
//
// The primary store: a corrupt file throws loudly rather than reading as an
// empty view, because the user's marks are not recoverable.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { applyPatch, PatchError, type PatchOp } from './jsonpatch.js';

export class ViewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Templates the web knows how to draw. Each names the shape its data must have. */
export const TEMPLATES = ['review-list'] as const;
export type Template = (typeof TEMPLATES)[number];

export const MAX_DATA_BYTES = 1024 * 1024;
const ID_RE = /^[a-z0-9]{6,32}$/;

export interface Mark {
  verdict: 'yes' | 'no' | null;
  note: string;
  /** Changed since the last send to the agent. */
  unsent: boolean;
  at: number;
}

export interface ViewRecord {
  id: string;
  chatId: string;
  title: string;
  template: Template;
  data: unknown;
  /** Bumped by every change to title, template or data. */
  rev: number;
  marks: Record<string, Mark>;
  createdAt: number;
  updatedAt: number;
}

/** Item ids a template's data carries: the things the user can mark. */
export function itemIds(template: Template, data: unknown): string[] {
  if (template === 'review-list') {
    const items = (data as { items?: unknown })?.items;
    return Array.isArray(items) ? items.map((i) => (i as { id: string }).id) : [];
  }
  return [];
}

/** Throws a ViewError naming what is wrong with `data` for `template`. */
export function validateData(template: Template, data: unknown): void {
  if (JSON.stringify(data).length > MAX_DATA_BYTES) throw new ViewError(400, 'data is over 1 MB');
  if (template !== 'review-list') throw new ViewError(400, `unknown template "${template}"`);
  const d = data as { items?: unknown; heading?: unknown };
  if (!d || typeof d !== 'object' || !Array.isArray(d.items)) {
    throw new ViewError(
      400,
      'review-list data must be { heading?: string, items: [{ id, title, detail? }] }',
    );
  }
  const seen = new Set<string>();
  for (const [n, raw] of d.items.entries()) {
    const it = raw as { id?: unknown; title?: unknown; detail?: unknown };
    if (!it || typeof it.id !== 'string' || !it.id || typeof it.title !== 'string' || !it.title) {
      throw new ViewError(400, `items[${n}] needs a string id and title`);
    }
    if (it.detail !== undefined && typeof it.detail !== 'string') {
      throw new ViewError(400, `items[${n}].detail must be a string`);
    }
    if (seen.has(it.id)) throw new ViewError(400, `duplicate item id "${it.id}"`);
    seen.add(it.id);
  }
  if (d.heading !== undefined && typeof d.heading !== 'string') {
    throw new ViewError(400, 'heading must be a string');
  }
}

export class ViewStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private save(v: ViewRecord): void {
    const tmp = `${this.file(v.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(v));
    renameSync(tmp, this.file(v.id));
  }

  get(id: string): ViewRecord | null {
    if (!ID_RE.test(id) || !existsSync(this.file(id))) return null;
    return JSON.parse(readFileSync(this.file(id), 'utf8')) as ViewRecord;
  }

  mustGet(id: string): ViewRecord {
    const v = this.get(id);
    if (!v) throw new ViewError(404, `no view "${id}"`);
    return v;
  }

  list(): ViewRecord[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as ViewRecord)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Full copy: creates the view, or replaces title, template and data of an existing one. */
  set(input: {
    id?: string;
    chatId: string;
    title: string;
    template: Template;
    data: unknown;
  }): ViewRecord {
    validateData(input.template, input.data);
    const now = Date.now();
    const cur = input.id ? this.mustGet(input.id) : null;
    if (cur && cur.chatId !== input.chatId) {
      throw new ViewError(
        400,
        `view "${cur.id}" belongs to another chat; only its chat can change it`,
      );
    }
    const v: ViewRecord = cur ?? {
      id: randomBytes(6).toString('hex'),
      chatId: input.chatId,
      title: input.title,
      template: input.template,
      data: input.data,
      rev: 0,
      marks: {},
      createdAt: now,
      updatedAt: now,
    };
    v.title = input.title;
    v.template = input.template;
    v.data = input.data;
    v.rev += 1;
    v.updatedAt = now;
    this.dropOrphanMarks(v);
    this.save(v);
    return v;
  }

  /** Small changes. `baseRev`, when given, must be the current rev: the agent was working from a stale copy otherwise. */
  patch(id: string, chatId: string, ops: PatchOp[], baseRev?: number): ViewRecord {
    const v = this.mustGet(id);
    if (v.chatId !== chatId) throw new ViewError(400, `view "${id}" belongs to another chat`);
    if (baseRev !== undefined && baseRev !== v.rev) {
      throw new ViewError(
        409,
        `view is at rev ${v.rev}, not ${baseRev}; read it again, or send the full data with patch_view_set`,
      );
    }
    let next: unknown;
    try {
      next = applyPatch(v.data, ops);
    } catch (err) {
      if (err instanceof PatchError) throw new ViewError(400, err.message);
      throw err;
    }
    validateData(v.template, next);
    v.data = next;
    v.rev += 1;
    v.updatedAt = Date.now();
    this.dropOrphanMarks(v);
    this.save(v);
    return v;
  }

  /** The user's mark on one item. A mark that is back to nothing is removed. */
  mark(
    id: string,
    itemId: string,
    change: { verdict?: 'yes' | 'no' | null; note?: string },
  ): ViewRecord {
    const v = this.mustGet(id);
    if (!itemIds(v.template, v.data).includes(itemId))
      throw new ViewError(404, `no item "${itemId}" in this view`);
    const cur = v.marks[itemId] ?? { verdict: null, note: '', unsent: false, at: 0 };
    const next: Mark = {
      verdict: change.verdict !== undefined ? change.verdict : cur.verdict,
      note: change.note !== undefined ? change.note : cur.note,
      unsent: true,
      at: Date.now(),
    };
    if (next.verdict === null && next.note === '') {
      // Cleared. If the agent had been told of a mark, it needs telling it is gone.
      if (!v.marks[itemId]) return v;
      next.unsent = true;
    }
    v.marks[itemId] = next;
    v.updatedAt = Date.now();
    this.save(v);
    return v;
  }

  /** Marks changed since the last send; flipped to sent when `commit` is true. */
  takeUnsent(id: string, commit: boolean): { itemId: string; mark: Mark }[] {
    const v = this.mustGet(id);
    const out = Object.entries(v.marks)
      .filter(([, m]) => m.unsent)
      .map(([itemId, mark]) => ({ itemId, mark: { ...mark } }));
    if (commit && out.length) {
      for (const { itemId } of out) {
        const m = v.marks[itemId]!;
        m.unsent = false;
        if (m.verdict === null && m.note === '') delete v.marks[itemId];
      }
      this.save(v);
    }
    return out;
  }

  remove(id: string): void {
    this.mustGet(id);
    rmSync(this.file(id));
  }

  private dropOrphanMarks(v: ViewRecord): void {
    const ids = new Set(itemIds(v.template, v.data));
    for (const k of Object.keys(v.marks)) if (!ids.has(k)) delete v.marks[k];
  }
}
