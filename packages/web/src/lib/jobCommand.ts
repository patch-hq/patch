// `/job <name>` slash command. Typing it in the composer fires the named job
// once, right now (the same manual run as the Jobs page's "Run now"), instead
// of sending a chat turn. Pure parse + match so the composer/ChatRoute stay
// thin dispatchers.

export const JOB_COMMAND_NAME = 'job';
export const JOB_COMMAND_DESCRIPTION = 'Run a job now: /job <name>';

export interface JobCommand {
  isJob: boolean;
  /** Text after `/job`, trimmed; `null` when nothing followed. */
  query: string | null;
}

export function parseJobCommand(message: string): JobCommand {
  const m = /^\/job(?:\s+([\s\S]*))?$/i.exec(message.trim());
  if (!m) return { isJob: false, query: null };
  const rest = (m[1] ?? '').trim();
  return { isJob: true, query: rest.length > 0 ? rest : null };
}

export type JobMatch =
  | { kind: 'one'; id: string }
  | { kind: 'none' }
  | { kind: 'many'; names: string[] };

/** Exact id or name (case-insensitive) wins; otherwise a unique name prefix/substring. */
export function matchJob(jobs: { id: string; name: string }[], query: string): JobMatch {
  const q = query.trim().toLowerCase();
  const exact = jobs.filter((j) => j.id === query.trim() || j.name.toLowerCase() === q);
  if (exact.length === 1) return { kind: 'one', id: exact[0]!.id };
  const pool =
    exact.length > 1
      ? exact
      : (() => {
          const starts = jobs.filter((j) => j.name.toLowerCase().startsWith(q));
          return starts.length > 0 ? starts : jobs.filter((j) => j.name.toLowerCase().includes(q));
        })();
  if (pool.length === 0) return { kind: 'none' };
  if (pool.length === 1) return { kind: 'one', id: pool[0]!.id };
  return { kind: 'many', names: pool.map((j) => j.name) };
}
