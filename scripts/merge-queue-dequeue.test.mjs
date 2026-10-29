import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleDequeue, marker } from './merge-queue-dequeue.mjs';

function fakes({ state = 'OPEN', reason = 'FAILED_CHECKS', tasks = [] } = {}) {
  const calls = [];
  const gh = (args) => {
    if (args[0] === 'pr') return JSON.stringify({ number: 99, title: 'Add thing', url: 'https://gh/pr/99', state });
    if (args[0] === 'api') {
      return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: [{ reason }] } } } } });
    }
    if (args[0] === 'run') {
      return JSON.stringify([{ url: 'https://gh/run/7', headBranch: 'gh-readonly-queue/main/pr-99-abc', conclusion: 'failure' }]);
    }
    throw new Error(`unexpected gh ${args}`);
  };
  const td = (args, stdin) => {
    calls.push({ args, stdin });
    if (args[1] === 'list') return JSON.stringify({ results: tasks });
    if (args[1] === 'add') return JSON.stringify({ id: 't1' });
    return '{}';
  };
  return { gh, td, calls };
}
const base = { repo: 'patch-hq/patch', pr: 99, project: 'P1' };

test('failed checks create one task with reason and failing run', () => {
  const f = fakes();
  const r = handleDequeue({ ...base, gh: f.gh, td: f.td });
  assert.deepEqual(r, { action: 'created', reason: 'failed_checks', taskId: 't1' });
  const adds = f.calls.filter((c) => c.args[0] === 'task' && c.args[1] === 'add');
  assert.equal(adds.length, 1);
  assert.match(adds[0].args[2], /#99 \(failed_checks\)/);
  const desc = adds[0].args[adds[0].args.indexOf('--description') + 1];
  assert.match(desc, /https:\/\/gh\/run\/7/);
  assert.match(desc, new RegExp(marker('patch-hq/patch', 99)));
});

test('a second dequeue comments on the open task instead of adding one', () => {
  const f = fakes({ tasks: [{ id: 'old', description: `x\n${marker('patch-hq/patch', 99)}` }] });
  const r = handleDequeue({ ...base, gh: f.gh, td: f.td });
  assert.deepEqual(r, { action: 'commented', reason: 'failed_checks', taskId: 'old' });
  assert.equal(f.calls.filter((c) => c.args[0] === 'task' && c.args[1] === 'add').length, 0);
  assert.match(f.calls.find((c) => c.args[0] === 'comment').stdin, /^🤖/);
});

test('another PR\'s task does not dedupe', () => {
  const f = fakes({ tasks: [{ id: 'o', description: marker('patch-hq/patch', 9) }] });
  assert.equal(handleDequeue({ ...base, gh: f.gh, td: f.td }).action, 'created');
});

test('manual removals and closed or merged PRs are skipped', () => {
  assert.equal(handleDequeue({ ...base, ...fakes({ reason: 'MANUAL' }) }).action, 'skipped');
  assert.equal(handleDequeue({ ...base, ...fakes({ state: 'MERGED' }) }).action, 'skipped');
  assert.equal(handleDequeue({ ...base, ...fakes({ state: 'CLOSED' }) }).action, 'skipped');
});

test('merge conflicts are recorded without a run link; unknown reasons fail loudly', () => {
  const f = fakes({ reason: 'MERGE_CONFLICT' });
  handleDequeue({ ...base, gh: f.gh, td: f.td });
  const add = f.calls.find((c) => c.args[0] === 'task' && c.args[1] === 'add');
  assert.doesNotMatch(add.args[add.args.indexOf('--description') + 1], /run\/7/);
  assert.throws(() => handleDequeue({ ...base, ...fakes({ reason: 'WEIRD' }) }), /unknown merge-queue removal reason/);
});
