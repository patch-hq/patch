# Bug reports and the issue-fixer queue

Patch can file its own errors as GitHub issues, and a job can pick each one up and fix it.

## What is filed

- Automatic (Settings → Bug reports → File errors automatically, **off by default**): every error-level server log line, every uncaught server exception, every phone crash report, and every turn that fails on a host (`sdk_error`, except usage and rate limits).
- Manual (Settings → Bug reports → Report a bug button): opens a preview of the whole report, filled in with the model in use, app version, platform, surface, screen and the last few error messages shown. You type the title and details, can edit or delete any field or error line, and nothing is sent until you press Send. What is sent is exactly what the preview shows; a field you clear stays out of the issue. It works even with automatic filing off, because confirming is the consent.

Only an allowlist leaves the install: kind, build version, platform, an error message, a stack, and for manual reports the typed text, a screen name and the model name. Prompts, chat content, ids, hostnames, paths, emails, addresses and credentials are not inputs, and the free text that is sent is scrubbed of them (`packages/server/src/issue-scrub.ts`).

One bug is one issue: a fingerprint of the message and top stack frame is kept locally and searched for in the repo before filing. New issues are capped at 10 an hour. A report that cannot be filed stays queued and the reason shows on the Settings page.

## Server configuration

| Variable                   | Meaning                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH_ISSUE_GITHUB_TOKEN` | GitHub token that may create issues (fine-grained, Issues: read and write on the repo). Without it nothing is filed and Settings says so. |
| `PATCH_ISSUE_REPO`         | `owner/name` to file into. Defaults to the project's release repo.                                                                        |

The switch is stored in `issue-reporting.json` and the queue in `issue-filer-state.json`, both in the server data dir.

## The fix queue

Auto-filed issues carry the `auto-filed` label. `docs/issue-fixer-job.json` is a job that fires on each one and has an agent fix it and open a PR. To use it:

1. Fill in `hostId` and `folder` (a checkout of the repo) in the file, and choose a secret.
2. `patch jobs create docs/issue-fixer-job.json`
3. Add a webhook to the GitHub repo: payload URL from `patch jobs hooks`, content type `application/json`, the same secret, event **Issues**.
