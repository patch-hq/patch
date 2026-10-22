// Job alerts — a job run that failed to dispatch (or whose gate broke) stays
// visible until the person dismisses it or the job next runs successfully.
//
// Without this a failed fire is a line in the job's run log and nothing else:
// no chat exists to show it, so the only sign is the report that never arrives.
//
// One alert per job (the latest failure). `<dataDir>/job-alerts.json`, written
// atomically. It is a derived store - the run log is the record - so a corrupt
// file is logged loudly and read as empty rather than taking the server down.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import type { RunLogEntry } from './logs.js';

export interface JobAlert {
  jobId: string;
  /** The job's name, resolved when the alert is listed. */
  jobName: string;
  status: 'dispatch-error' | 'gate-error';
  /** When the failed run happened (ms). */
  ts: number;
  /** What went wrong, in plain words. */
  reason: string;
  /** What to do about it. */
  fix: string;
  /** The run log's own error text, for the curious. */
  detail: string;
  /** Where in the app the fix is done, when it is a page. */
  fixPath?: string;
}

interface StoredAlert {
  status: JobAlert['status'];
  ts: number;
  error: string;
}

const REFUSED = /refused the action: ([a-z_]+)(?:: |$)/;

const BY_CODE: Record<string, { reason: string; fix: string; fixPath?: string }> = {
  chatgpt_login_required: {
    reason: 'ChatGPT is not signed in on the host that runs this job.',
    fix: 'Sign in to ChatGPT in Settings → Hosts.',
    fixPath: '/settings/hosts',
  },
  claude_oauth_missing: {
    reason: 'Claude is not signed in on the host that runs this job.',
    fix: 'Add a Claude account in Settings → Usage.',
    fixPath: '/settings/usage',
  },
  claude_session_invalid: {
    reason: "The host's Claude sign-in has expired.",
    fix: 'Sign in to Claude again in Settings → Usage.',
    fixPath: '/settings/usage',
  },
  claude_session_missing: {
    reason: 'Claude is not signed in on the host that runs this job.',
    fix: 'Add a Claude account in Settings → Usage.',
    fixPath: '/settings/usage',
  },
  folder_not_found: {
    reason: "The job's folder does not exist on the host.",
    fix: 'Edit the job and pick a folder that exists.',
  },
  folder_missing: {
    reason: "The job's folder does not exist on the host.",
    fix: 'Edit the job and pick a folder that exists.',
  },
  host_not_registered: {
    reason: "The job's host is not registered with this account.",
    fix: 'Edit the job and pick a host from Settings → Hosts.',
    fixPath: '/settings/hosts',
  },
};

/** Plain-words reason and fix for a failed run's error text. */
export function describeFailure(
  status: JobAlert['status'],
  error: string,
): Pick<JobAlert, 'reason' | 'fix' | 'fixPath'> {
  if (status === 'gate-error') {
    return {
      reason: `The job's gate broke, so the job did not run: ${error}`,
      fix: "Fix the gate script, then check the job's run log.",
    };
  }
  const code = REFUSED.exec(error)?.[1];
  const known = code === undefined ? undefined : BY_CODE[code];
  if (known) return known;
  return {
    reason: error.length > 0 ? error : 'The job could not be handed to its host.',
    fix: "Check the host is online, then see the job's run log.",
  };
}

export class JobAlerts {
  private readonly path: string;
  private alerts: Record<string, StoredAlert> = {};

  constructor(
    dataDir: string,
    private readonly jobName: (jobId: string) => string | null,
    private readonly logger: Logger,
  ) {
    this.path = join(dataDir, 'job-alerts.json');
    this.alerts = this.load();
  }

  /**
   * Feed every run-log entry here: a failure raises the alert, an `ok` clears it.
   * Returns true when a failure raised a NEW alert (none was standing for the job),
   * so a gate that breaks every few minutes is announced once, not every fire.
   */
  onRun(entry: RunLogEntry): boolean {
    if (entry.status === 'dispatch-error' || entry.status === 'gate-error') {
      const fresh = !this.alerts[entry.jobId];
      this.alerts[entry.jobId] = {
        status: entry.status,
        ts: entry.ts,
        error: entry.error ?? '',
      };
      this.save();
      return fresh;
    }
    if (entry.status === 'ok' && this.alerts[entry.jobId]) {
      delete this.alerts[entry.jobId];
      this.save();
    }
    return false;
  }

  /** Newest first. A job that no longer exists has no alert. */
  list(): JobAlert[] {
    const out: JobAlert[] = [];
    for (const [jobId, a] of Object.entries(this.alerts)) {
      const jobName = this.jobName(jobId);
      if (jobName === null) continue;
      out.push({
        jobId,
        jobName,
        status: a.status,
        ts: a.ts,
        detail: a.error,
        ...describeFailure(a.status, a.error),
      });
    }
    return out.sort((x, y) => y.ts - x.ts);
  }

  /** True when there was an alert to dismiss. */
  dismiss(jobId: string): boolean {
    if (!this.alerts[jobId]) return false;
    delete this.alerts[jobId];
    this.save();
    return true;
  }

  private load(): Record<string, StoredAlert> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed as Record<string, StoredAlert>;
    } catch (err) {
      this.logger.error(
        { path: this.path, err: (err as Error).message },
        'job-alerts: file unreadable, starting with no alerts',
      );
      return {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.alerts), 'utf8');
    renameSync(tmp, this.path);
  }
}
