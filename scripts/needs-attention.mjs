// One "needs attention" event -> one webhook to Patch, which spawns a fresh chat
// for the PR or issue. Every failure path (failed PR check, failed merge-queue
// run, conflict after main moves, new issue) ends here. Nothing is handed back
// to the chat that opened the PR.
//
//   PATCH_ATTENTION_URL=... PATCH_ATTENTION_SECRET=... \
//     node scripts/needs-attention.mjs --kind pr-check-failed --number 99 --repo patch-hq/patch --detail "<url>"
//
// kind: pr-check-failed | merge-queue-failed | pr-conflict | issue-opened

import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const KINDS = ['pr-check-failed', 'merge-queue-failed', 'pr-conflict', 'issue-opened'];

/** A merge-queue branch is `gh-readonly-queue/<base>/pr-<n>-<sha>`. */
export function prFromQueueBranch(branch) {
  const m = /^gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]+$/.exec(String(branch ?? ''));
  if (!m) throw new Error(`not a merge-queue branch: ${branch}`);
  return Number(m[1]);
}

export function buildPayload({ kind, repo, number, detail }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`bad repo: ${repo}`);
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`bad number: ${number}`);
  const isIssue = kind === 'issue-opened';
  return {
    kind,
    repo,
    number: n,
    type: isIssue ? 'issue' : 'pr',
    url: `https://github.com/${repo}/${isIssue ? 'issues' : 'pull'}/${n}`,
    detail: detail ?? '',
  };
}

export function sign(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export async function send({ url, secret, payload, fetchImpl = fetch }) {
  const body = JSON.stringify(payload);
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(secret, body) },
    body,
  });
  if (!res.ok) throw new Error(`webhook ${res.status}: ${await res.text()}`);
  return res.status;
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const url = process.env.PATCH_ATTENTION_URL;
  const secret = process.env.PATCH_ATTENTION_SECRET;
  if (!url || !secret) throw new Error('PATCH_ATTENTION_URL and PATCH_ATTENTION_SECRET are required');
  const kind = arg(argv, 'kind');
  const number = kind === 'merge-queue-failed' && arg(argv, 'branch')
    ? prFromQueueBranch(arg(argv, 'branch'))
    : arg(argv, 'number');
  const payload = buildPayload({ kind, repo: arg(argv, 'repo'), number, detail: arg(argv, 'detail') });
  await send({ url, secret, payload });
  console.log(JSON.stringify({ sent: payload }));
}
