// A PR left the merge queue: turn it into one task in the app-updates Todoist
// project, or a comment on the task that is already open for it. GitHub owns a
// PR from green to merged; this is the only thing that happens when it gives
// one back. It never re-queues anything.
//
//   node scripts/merge-queue-dequeue.mjs --repo patch-hq/patch --pr 99 --project <todoist project id>
//
// Run by the Patch job that receives GitHub's pull_request `dequeued` event.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REASONS = {
  FAILED_CHECKS: 'failed_checks',
  MERGE_CONFLICT: 'merge_conflict',
  INVALID_MERGE_COMMIT: 'invalid_merge_commit',
  MANUAL: 'manual',
};

export function normaliseReason(raw) {
  const r = String(raw ?? '').toUpperCase();
  const known = {
    FAILED_CHECKS: REASONS.FAILED_CHECKS,
    MERGE_CONFLICT: REASONS.MERGE_CONFLICT,
    INVALID_MERGE_COMMIT: REASONS.INVALID_MERGE_COMMIT,
    ALREADY_MERGED: 'already_merged',
    QUEUE_CONFLICT: REASONS.MERGE_CONFLICT,
    QUEUE_MERGE_CONFLICT: REASONS.MERGE_CONFLICT,
    MANUAL: REASONS.MANUAL,
    MANUALLY_REMOVED: REASONS.MANUAL,
    USER_REMOVED: REASONS.MANUAL,
    MANUAL_REMOVAL: REASONS.MANUAL,
  };
  if (!(r in known)) throw new Error(`unknown merge-queue removal reason: ${raw}`);
  return known[r];
}

/** Marker in a task's description that ties it to one PR. */
export const marker = (repo, pr) => `merge-queue-pr:${repo}#${pr}`;

/**
 * @param {{ repo: string, pr: number, project: string,
 *   gh: (args: string[]) => string, td: (args: string[], stdin?: string) => string }} o
 * @returns {{ action: 'skipped' | 'created' | 'commented', why?: string, reason?: string, taskId?: string }}
 */
export function handleDequeue({ repo, pr, project, gh, td }) {
  const view = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'number,title,url,state']));
  if (view.state !== 'OPEN') return { action: 'skipped', why: `PR is ${view.state.toLowerCase()}` };

  // GitHub re-queues a dequeued PR about 10s later while auto-merge is on (its
  // branch is still green), so this comes before anything else. Whoever fixes
  // the PR turns it back on with gh pr merge --auto after pushing.
  gh(['pr', 'merge', String(pr), '--disable-auto', '--repo', repo]);

  const [owner, name] = repo.split('/');
  const timeline = JSON.parse(
    gh([
      'api', 'graphql',
      '-f', `owner=${owner}`, '-f', `repo=${name}`, '-F', `number=${pr}`,
      '-f', `query=query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
          timelineItems(last: 20, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
            nodes { ... on RemovedFromMergeQueueEvent { reason createdAt } } } } } }`,
    ]),
  );
  const nodes = timeline.data.repository.pullRequest.timelineItems.nodes;
  if (nodes.length === 0) throw new Error(`PR #${pr} has no merge-queue removal event`);
  const reason = normaliseReason(nodes[nodes.length - 1].reason);
  if (reason === REASONS.MANUAL) return { action: 'skipped', why: 'manual removal', reason };
  if (reason === 'already_merged') return { action: 'skipped', why: 'already merged', reason };

  let runUrl = '';
  if (reason === REASONS.FAILED_CHECKS || reason === REASONS.INVALID_MERGE_COMMIT) {
    const runs = JSON.parse(
      gh(['run', 'list', '--repo', repo, '--workflow', 'test', '--event', 'merge_group', '--limit', '30',
        '--json', 'url,headBranch,conclusion']),
    );
    runUrl = runs.find((r) => r.conclusion === 'failure' && r.headBranch.includes(`/pr-${pr}-`))?.url ?? '';
  }

  const m = marker(repo, pr);
  const body = [
    `Removed from the merge queue: ${reason}`,
    `PR: ${view.url}`,
    runUrl ? `Failing merge-group run: ${runUrl}` : '',
  ].filter(Boolean);

  const open = JSON.parse(td(['task', 'list', '--project', `id:${project}`, '--all', '--json']));
  const existing = (open.results ?? open).find((t) => (t.description ?? '').includes(m));
  if (existing) {
    td(['comment', 'add', existing.id, '--stdin'], `🤖 Dequeued again.\n${body.join('\n')}`);
    return { action: 'commented', reason, taskId: existing.id };
  }

  const created = JSON.parse(
    td(
      ['task', 'add', `Fix #${pr} (${reason}): ${view.title}`, '--project', `id:${project}`,
        '--description', `${body.join('\n')}\n\nFix the cause and push, then enable auto-merge with gh pr merge --auto. Do not re-queue the PR.\n\n${m}`,
        '--json'],
    ),
  );
  return { action: 'created', reason, taskId: created.id };
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || !argv[i + 1]) throw new Error(`missing --${name}`);
  return argv[i + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const run = (bin) => (args, input) => execFileSync(bin, args, { encoding: 'utf8', input });
  const argv = process.argv.slice(2);
  const result = handleDequeue({
    repo: arg(argv, 'repo'),
    pr: Number(arg(argv, 'pr')),
    project: arg(argv, 'project'),
    gh: run('gh'),
    td: run('td'),
  });
  console.log(JSON.stringify(result));
}
