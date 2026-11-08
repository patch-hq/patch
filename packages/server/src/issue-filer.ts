// Privacy-preserving GitHub issue filer.
//
// Two ways in, one way out:
//   - automatic: every server error log line, uncaught exception and phone crash
//     becomes a report — only when "Share bug reports" is on (off by default);
//   - manual: the Report a bug button, which always works because pressing it
//     is the consent, and says what it sent.
//
// What leaves is an ALLOWLIST: kind, build version, platform, a scrubbed error
// message, a scrubbed stack, and (manual only) the words the person typed and a
// route name. Prompts, chat content, ids, paths, hosts and log fields are not
// inputs here at all, so they cannot be sent by accident. Free text is then run
// through `scrub` (issue-scrub.ts).
//
// Reports go to a durable outbox first (synchronous write, so an uncaught
// exception that kills the process still files on the next start), then a
// flush files them. Repeats are collapsed by fingerprint, locally and by
// searching the repo, so one bug is one issue.
//
// NO FALLBACK: a report that cannot be filed stays in the outbox and the
// failure is the status shown in Settings; nothing is dropped quietly except
// past the outbox cap, which is logged.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { normaliseMessage, scrubTo, topFrame } from './issue-scrub.js';

export type ReportKind = 'server-error' | 'uncaught' | 'client-crash' | 'manual';

export interface IssueReport {
  kind: ReportKind;
  /** The error message (automatic) or the person's title (manual). */
  message: string;
  stack?: string | undefined;
  /** Manual only: what the person typed. */
  description?: string | undefined;
  /** Surface that reported it, e.g. `web`, `mobile`, `server`. */
  surface?: string | undefined;
  /** Route pattern / screen name, never an id. */
  route?: string | undefined;
  build?: string | undefined;
  platform?: string | undefined;
  /** Manual only: the model in use, as the person confirmed in the preview. */
  model?: string | undefined;
}

interface StoredReport extends IssueReport {
  fingerprint: string;
  at: number;
}

interface FiledEntry {
  number: number;
  url: string;
  count: number;
}

interface State {
  filed: Record<string, FiledEntry>;
  outbox: StoredReport[];
  /** Epoch ms of each issue created in the last hour. */
  created: number[];
  lastError: string | null;
}

export interface IssueFilerStatus {
  enabled: boolean;
  repo: string;
  tokenConfigured: boolean;
  pending: number;
  filed: number;
  lastError: string | null;
}

export interface IssueFilerOptions {
  dataDir: string;
  logger: Logger;
  repo: string;
  token: string | undefined;
  /** This server's own build, for reports that did not come with one. */
  version: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export const AUTO_LABELS = ['auto-filed', 'bug'];
const MAX_OUTBOX = 50;
const MAX_NEW_PER_HOUR = 10;
const HOUR = 3_600_000;
const LIMITS = { message: 300, stack: 3_000, description: 4_000, field: 80 };

export class IssueFilerError extends Error {}

export class IssueFiler {
  private state: State;
  private enabled: boolean;
  private flushing: Promise<void> | null = null;
  private readonly settingsFile: string;
  private readonly stateFile: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: IssueFilerOptions) {
    this.settingsFile = join(opts.dataDir, 'issue-reporting.json');
    this.stateFile = join(opts.dataDir, 'issue-filer-state.json');
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.enabled = this.readEnabled();
    this.state = this.readState();
  }

  status(): IssueFilerStatus {
    return {
      enabled: this.enabled,
      repo: this.opts.repo,
      tokenConfigured: Boolean(this.opts.token),
      pending: this.state.outbox.length,
      filed: Object.keys(this.state.filed).length,
      lastError: this.state.lastError,
    };
  }

  setEnabled(enabled: boolean): void {
    this.writeAtomic(this.settingsFile, { enabled });
    this.enabled = enabled;
  }

  /**
   * Queue an automatic report. Synchronous and never throws: it is called from
   * the logger and from a dying process. Does nothing while reporting is off.
   */
  reportAuto(report: IssueReport): void {
    if (!this.enabled) return;
    try {
      this.enqueue(report);
    } catch (err) {
      this.opts.logger.warn({ err }, 'issue-filer: could not queue a report');
    }
  }

  /** File what is queued. Safe to call often; concurrent calls share one run. */
  flush(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.flushing ??= this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** File one report now, for the Report a bug button; resolves to the issue URL. */
  async fileManual(report: IssueReport): Promise<string> {
    const stored = this.prepare({ ...report, kind: 'manual' });
    // A manual report is always its own issue: the person is describing something.
    stored.fingerprint = `manual-${this.now().toString(36)}-${stored.fingerprint.slice(0, 6)}`;
    const url = await this.create(stored, ['bug', 'user-reported']);
    return url;
  }

  private prepare(report: IssueReport): StoredReport {
    const message = scrubTo(report.message, LIMITS.message);
    const stack = report.stack ? scrubTo(report.stack, LIMITS.stack) : undefined;
    const fingerprint = createHash('sha256')
      .update([report.kind, normaliseMessage(report.message), topFrame(report.stack)].join('|'))
      .digest('hex')
      .slice(0, 16);
    const field = (v: string | undefined): string | undefined =>
      v === undefined || v === '' ? undefined : scrubTo(v, LIMITS.field);
    return {
      kind: report.kind,
      message,
      ...(stack ? { stack } : {}),
      ...(report.description
        ? { description: scrubTo(report.description, LIMITS.description) }
        : {}),
      surface: field(report.surface),
      route: field(report.route),
      // A manual report is exactly what the person confirmed: a field they deleted stays gone.
      build: field(report.build) ?? (report.kind === 'manual' ? undefined : this.opts.version),
      platform:
        field(report.platform) ?? (report.kind === 'manual' ? undefined : `${process.platform}`),
      model: field(report.model),
      fingerprint,
      at: this.now(),
    };
  }

  private enqueue(report: IssueReport): void {
    const stored = this.prepare(report);
    const known = this.state.filed[stored.fingerprint];
    if (known) {
      known.count += 1;
      this.save();
      return;
    }
    if (this.state.outbox.some((r) => r.fingerprint === stored.fingerprint)) return;
    this.state.outbox.push(stored);
    if (this.state.outbox.length > MAX_OUTBOX) {
      const dropped = this.state.outbox.splice(0, this.state.outbox.length - MAX_OUTBOX);
      this.opts.logger.warn(
        { dropped: dropped.length },
        'issue-filer: outbox full, oldest reports dropped',
      );
    }
    this.save();
    void this.flush().catch(() => undefined);
  }

  private async drain(): Promise<void> {
    if (!this.opts.token) {
      this.fail('no GitHub token configured (PATCH_ISSUE_GITHUB_TOKEN)');
      return;
    }
    while (this.state.outbox.length > 0) {
      const next = this.state.outbox[0] as StoredReport;
      if (this.recentCreates() >= MAX_NEW_PER_HOUR) {
        this.fail(`rate limit: ${MAX_NEW_PER_HOUR} new issues an hour`);
        return;
      }
      try {
        await this.fileOne(next);
      } catch (err) {
        this.fail(err instanceof Error ? err.message : String(err));
        return;
      }
      this.state.outbox.shift();
      this.state.lastError = null;
      this.save();
    }
  }

  private async fileOne(report: StoredReport): Promise<void> {
    const existing = await this.search(report.fingerprint);
    if (existing) {
      this.state.filed[report.fingerprint] = { ...existing, count: 1 };
      return;
    }
    await this.create(report, AUTO_LABELS);
  }

  private recentCreates(): number {
    const cutoff = this.now() - HOUR;
    this.state.created = this.state.created.filter((t) => t > cutoff);
    return this.state.created.length;
  }

  private async gh(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.opts.token) throw new IssueFilerError('no GitHub token configured');
    const res = await this.doFetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.opts.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'patch-issue-filer',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      throw new IssueFilerError(`GitHub ${res.status} on ${init.method ?? 'GET'} ${path}: ${text}`);
    }
    return res.json();
  }

  private async search(fingerprint: string): Promise<{ number: number; url: string } | null> {
    const q = encodeURIComponent(
      `repo:${this.opts.repo} is:issue "${marker(fingerprint)}" in:body`,
    );
    const body = (await this.gh(`/search/issues?q=${q}&per_page=1`)) as {
      items?: { number: number; html_url: string }[];
    };
    const hit = body.items?.[0];
    return hit ? { number: hit.number, url: hit.html_url } : null;
  }

  private async create(report: StoredReport, labels: string[]): Promise<string> {
    const issue = (await this.gh(`/repos/${this.opts.repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: titleFor(report), body: bodyFor(report), labels }),
    })) as { number: number; html_url: string };
    this.state.created.push(this.now());
    this.state.filed[report.fingerprint] = { number: issue.number, url: issue.html_url, count: 1 };
    this.save();
    return issue.html_url;
  }

  private fail(message: string): void {
    this.state.lastError = message;
    this.save();
    // warn, not error: an error here would be filed as an issue about the filer.
    this.opts.logger.warn({ issueFiler: message }, 'issue-filer: not filed');
  }

  private readEnabled(): boolean {
    if (!existsSync(this.settingsFile)) return false;
    const parsed = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as { enabled?: unknown };
    return parsed.enabled === true;
  }

  private readState(): State {
    const empty: State = { filed: {}, outbox: [], created: [], lastError: null };
    if (!existsSync(this.stateFile)) return empty;
    try {
      return { ...empty, ...(JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<State>) };
    } catch (err) {
      // Re-derivable (GitHub search finds earlier issues): log loudly and start clean.
      this.opts.logger.warn({ err }, 'issue-filer: state unreadable, starting empty');
      return empty;
    }
  }

  private save(): void {
    this.writeAtomic(this.stateFile, this.state);
  }

  private writeAtomic(file: string, value: unknown): void {
    mkdirSync(this.opts.dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  }
}

function marker(fingerprint: string): string {
  return `patch-fp-${fingerprint}`;
}

const KIND_LABEL: Record<ReportKind, string> = {
  'server-error': 'Server error',
  uncaught: 'Server crash',
  'client-crash': 'App crash',
  manual: 'Bug report',
};

function titleFor(r: StoredReport): string {
  const first = (r.message.split('\n')[0] ?? '').slice(0, 100);
  return `[${KIND_LABEL[r.kind]}] ${first}`;
}

function bodyFor(r: StoredReport): string {
  const lines: string[] = [];
  if (r.description) lines.push(r.description, '');
  const rows: [string, string | undefined][] = [
    ['Build', r.build],
    ['Platform', r.platform],
    ['Surface', r.surface],
    ['Screen', r.route],
    ['Model', r.model],
  ];
  const shown = rows.filter(([, v]) => v);
  if (shown.length > 0) {
    lines.push('| | |', '|---|---|', ...shown.map(([k, v]) => `| ${k} | ${v} |`));
  }
  lines.push('', '```', r.message, '```');
  if (r.stack)
    lines.push('', '<details><summary>Stack</summary>', '', '```', r.stack, '```', '</details>');
  lines.push(
    '',
    r.kind === 'manual'
      ? '_Filed from the Report a bug button. Sent after the person reviewed and confirmed exactly this content._'
      : '_Filed automatically by Patch. Contains no prompts, chat content or identifying data._',
    `<!-- ${marker(r.fingerprint)} -->`,
  );
  return lines.join('\n');
}
