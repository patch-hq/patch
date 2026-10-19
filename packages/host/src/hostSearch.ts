// Host search (spec/02 § Host search, spec/03 § Host search, spec/14 § File
// browser — ⌘⇧F search in files).
//
// Content search under one absolute directory, on THIS machine, with no chat
// in between — the search-in-files half of the host-wide file browser
// (`hostFiles.ts` is the browse/read/write half). A SESSION like a terminal's,
// not a request/response like `patch.host_files.*`: a search can take a while
// over a big tree, so matches stream back as they are found and the surface
// can cancel mid-walk.
//
// Plain substring, never a regex — the file browser's search box is "find this
// text", not a regex workbench, and a literal match can never throw on a
// malformed pattern.
//
// Prefers `rg` (ripgrep): it is already gitignore-aware, already skips binary
// files, and is fast enough that "streamed" rarely means more than one batch
// for a project-sized tree. A machine with no `rg` on PATH falls back to the
// host's own walk (`files-recursive.ts`'s git-aware listing, read and
// scanned line by line) — slower, but never a hard requirement.
//
// NO FALLBACK on anything else: a root that doesn't exist, isn't a directory,
// or escapes the canonical-absolute rule the host-files API already enforces
// is refused with `patch.host_search.done.ok: false`, never silently searched
// somewhere else.

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from 'pino';
import type {
  HostSearchMatch,
  PatchHostSearchCancelEvent,
  PatchHostSearchRequestEvent,
  WireEvent,
} from '@patch/wire';
import { isCanonicalAbsolute, isUtf8Text } from './hostFiles.js';
import { HARD_SKIP } from './files-recursive.js';

/** A search that found this many matches stops early and reports `truncated`. */
export const HOST_SEARCH_MAX_MATCHES = 500;

/** A preview line longer than this is cut — the results list is one line each. */
const MAX_PREVIEW_LEN = 300;

type DoneError = NonNullable<Extract<WireEvent, { type: 'patch.host_search.done' }>['error']>;

/** The manual-walk fallback never reads a file bigger than this. */
const MAX_FILE_BYTES_FOR_SCAN = 2 * 1024 * 1024;

/** The manual-walk fallback gives up after visiting this many files, matches or not. */
const MAX_FILES_SCANNED = 20_000;

function truncatePreview(line: string): string {
  return line.length > MAX_PREVIEW_LEN ? `${line.slice(0, MAX_PREVIEW_LEN)}…` : line;
}

interface RunningSearch {
  cancelled: boolean;
  kill: () => void;
}

export interface HostSearchManagerOptions {
  emit: (event: WireEvent) => void;
  logger: Logger;
}

/**
 * One instance per host, mirroring `TerminalSessions`: holds every search
 * currently walking, keyed by the surface-minted `searchId`.
 */
export class HostSearchManager {
  private readonly running = new Map<string, RunningSearch>();

  constructor(private readonly opts: HostSearchManagerOptions) {}

  handle(event: PatchHostSearchRequestEvent | PatchHostSearchCancelEvent): void {
    if (event.type === 'patch.host_search.cancel') {
      this.cancelSearch(event.searchId);
      return;
    }
    void this.start(event);
  }

  /** For a clean host shutdown — mirrors `TerminalSessions.endAll`. */
  cancelAll(): void {
    for (const searchId of [...this.running.keys()]) this.cancelSearch(searchId);
  }

  private cancelSearch(searchId: string): void {
    const r = this.running.get(searchId);
    if (!r) return;
    r.cancelled = true;
    r.kill();
    this.running.delete(searchId);
  }

  private emitEvent(event: WireEvent, forSurfaceId: string | undefined): void {
    this.opts.emit(forSurfaceId === undefined ? event : ({ ...event, forSurfaceId } as WireEvent));
  }

  private async start(event: PatchHostSearchRequestEvent): Promise<void> {
    const { searchId, root, query, forSurfaceId } = event;

    const emitDone = (
      ok: boolean,
      extra: { truncated?: boolean; error?: DoneError } = {},
    ): void => {
      this.running.delete(searchId);
      this.emitEvent({ type: 'patch.host_search.done', searchId, ok, ...extra }, forSurfaceId);
    };

    if (!isCanonicalAbsolute(root)) {
      emitDone(false, {
        error: { code: 'path_invalid', message: `root must be absolute and normalised: ${root}` },
      });
      return;
    }
    let info;
    try {
      info = statSync(root);
    } catch {
      emitDone(false, { error: { code: 'not_found', message: `nothing at ${root}` } });
      return;
    }
    if (!info.isDirectory()) {
      emitDone(false, { error: { code: 'not_a_directory', message: `not a directory: ${root}` } });
      return;
    }

    const control: RunningSearch = { cancelled: false, kill: () => {} };
    this.running.set(searchId, control);

    let matchCount = 0;
    let truncated = false;
    const onBatch = (batch: HostSearchMatch[]): void => {
      if (control.cancelled || batch.length === 0 || matchCount >= HOST_SEARCH_MAX_MATCHES) return;
      const room = HOST_SEARCH_MAX_MATCHES - matchCount;
      const slice = batch.length > room ? batch.slice(0, room) : batch;
      matchCount += slice.length;
      this.emitEvent({ type: 'patch.host_search.result', searchId, matches: slice }, forSurfaceId);
      if (matchCount >= HOST_SEARCH_MAX_MATCHES) {
        truncated = true;
        control.kill();
      }
    };

    const caseSensitive = event.caseSensitive === true;
    const rg = await this.runRipgrep(root, query, caseSensitive, control, onBatch);
    if (control.cancelled) return; // Cancel never gets a `done` — see class doc.
    if (rg === 'unavailable') {
      await this.runManualWalk(root, query, caseSensitive, control, onBatch);
      if (control.cancelled) return;
    } else if (rg === 'error') {
      emitDone(false, { error: { code: 'internal', message: `${searchId}: search failed` } });
      return;
    }
    emitDone(true, truncated ? { truncated: true } : {});
  }

  /** Returns `'ok'`, `'unavailable'` (no `rg` on PATH — fall back), or `'error'`. */
  private runRipgrep(
    root: string,
    query: string,
    caseSensitive: boolean,
    control: RunningSearch,
    onBatch: (batch: HostSearchMatch[]) => void,
  ): Promise<'ok' | 'unavailable' | 'error'> {
    return new Promise((resolve) => {
      const args = ['--line-number', '--column', '--no-heading', '--color=never', '-F'];
      if (!caseSensitive) args.push('-i');
      args.push('--', query, '.');
      const child = spawn('rg', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      control.kill = () => child.kill();

      let spawnFailed = false;
      let sawError = false;
      const decoder = new StringDecoder('utf8');
      let pending = '';
      const lineRe = /^(.+?):(\d+):(\d+):(.*)$/s;

      child.stdout.on('data', (buf: Buffer) => {
        pending += decoder.write(buf);
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        const batch: HostSearchMatch[] = [];
        for (const line of lines) {
          const m = lineRe.exec(line);
          if (!m) continue;
          const [, rawPath, lineNo, col, text] = m as unknown as [
            string,
            string,
            string,
            string,
            string,
          ];
          const path = rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
          batch.push({
            path,
            line: Number(lineNo),
            column: Number(col),
            preview: truncatePreview(text),
          });
        }
        if (batch.length > 0) onBatch(batch);
      });
      child.stderr.on('data', () => {
        sawError = true;
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        spawnFailed = err.code === 'ENOENT';
        if (!spawnFailed) {
          this.opts.logger.warn({ err: err.message }, 'host search: rg spawn failed');
        }
        resolve(spawnFailed ? 'unavailable' : 'error');
      });
      child.on('close', (code) => {
        if (spawnFailed) return; // 'error' listener already resolved.
        pending += decoder.end();
        if (pending.length > 0) {
          const m = lineRe.exec(pending);
          if (m) {
            const [, rawPath, lineNo, col, text] = m as unknown as [
              string,
              string,
              string,
              string,
              string,
            ];
            onBatch([
              {
                path: rawPath.startsWith('./') ? rawPath.slice(2) : rawPath,
                line: Number(lineNo),
                column: Number(col),
                preview: truncatePreview(text),
              },
            ]);
          }
        }
        // rg exits 0 (matches found), 1 (no matches — not an error), or 2+ (a
        // real failure, e.g. an unreadable root slipping past our own stat).
        resolve(code !== null && code > 1 && sawError ? 'error' : 'ok');
      });
    });
  }

  /** The no-`rg` fallback: the same git-aware walk the recursive index uses, read and scanned line by line. */
  private async runManualWalk(
    root: string,
    query: string,
    caseSensitive: boolean,
    control: RunningSearch,
    onBatch: (batch: HostSearchMatch[]) => void,
  ): Promise<void> {
    const needle = caseSensitive ? query : query.toLowerCase();
    let scanned = 0;
    const walk = async (dir: string): Promise<void> => {
      if (control.cancelled || scanned >= MAX_FILES_SCANNED) return;
      let dirents;
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of dirents) {
        if (control.cancelled || scanned >= MAX_FILES_SCANNED) return;
        if (HARD_SKIP.has(d.name)) continue;
        const abs = join(dir, d.name);
        if (d.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!d.isFile()) continue;
        scanned++;
        if (scanned % 200 === 0) {
          // Yield so cancellation and the event loop both get a look-in —
          // this walk is otherwise a long run of synchronous fs calls.
          await new Promise((r) => setImmediate(r));
        }
        this.scanFile(root, abs, needle, caseSensitive, onBatch);
      }
    };
    control.kill = () => {
      /* Cooperative only — `control.cancelled` (checked every file) is what actually stops the walk. */
    };
    await walk(root);
  }

  private scanFile(
    root: string,
    abs: string,
    needle: string,
    caseSensitive: boolean,
    onBatch: (batch: HostSearchMatch[]) => void,
  ): void {
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.size > MAX_FILE_BYTES_FOR_SCAN) return;
    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch {
      return;
    }
    if (!isUtf8Text(bytes)) return;
    const text = bytes.toString('utf8');
    const path = relative(root, abs);
    const batch: HostSearchMatch[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const hay = caseSensitive ? line : line.toLowerCase();
      const col = hay.indexOf(needle);
      if (col === -1) continue;
      batch.push({ path, line: i + 1, column: col + 1, preview: truncatePreview(line) });
    }
    if (batch.length > 0) onBatch(batch);
  }
}
