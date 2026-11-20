// One "needs attention" event -> one webhook to Patch, which spawns a fresh chat
// for the PR, issue or commit. Every failure path (failed PR check, failed run
// on main, conflict after main moves, new issue) ends here. Nothing is handed back
// to the chat that opened the PR.
//
//   PATCH_ATTENTION_URL=... PATCH_ATTENTION_SECRET=... \
//     node scripts/needs-attention.mjs --kind pr-check-failed --number 99 --repo patch-hq/patch --detail "<url>"
//     node scripts/needs-attention.mjs --kind main-failed --sha <commit> --repo patch-hq/patch --detail "<url, commits>"
//
// kind: pr-check-failed | main-failed | pr-conflict | issue-opened
//
// main-failed is a red test run on main. Its PRs are already merged and their
// branches gone, so it names the commit, not a PR: the fix is a new PR.

import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const KINDS = ['pr-check-failed', 'main-failed', 'pr-conflict', 'issue-opened'];

export function buildPayload({ kind, repo, number, sha, detail }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`bad repo: ${repo}`);
  if (kind === 'main-failed') {
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`bad sha: ${sha}`);
    return {
      kind,
      repo,
      sha,
      type: 'commit',
      url: `https://github.com/${repo}/commit/${sha}`,
      detail: detail ?? '',
    };
  }
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
  if (!url || !secret)
    throw new Error('PATCH_ATTENTION_URL and PATCH_ATTENTION_SECRET are required');
  const payload = buildPayload({
    kind: arg(argv, 'kind'),
    repo: arg(argv, 'repo'),
    number: arg(argv, 'number'),
    sha: arg(argv, 'sha'),
    detail: arg(argv, 'detail'),
  });
  await send({ url, secret, payload });
  console.log(JSON.stringify({ sent: payload }));
}
