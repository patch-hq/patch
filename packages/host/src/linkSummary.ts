// The message-link Summarise button (spec/14 § Message links): one cheap
// one-shot Claude query (Haiku) that summarises a page's text using the
// account's `linkSummaryPrompt`. Same one-shot shape as recurrenceTranslate.ts
// (SDK backend + the account-failover credit gate).
//
// NO FALLBACK: an OAuth miss, SDK error, timeout or empty reply is a thrown
// error / null the handler turns into `ok:false` — never an empty summary.

import type { SdkBackend } from './sdkBackend.js';
import type { RunOnAccountWithCredit } from './accountFailover.js';

export const LINK_SUMMARY_MODEL = 'claude-haiku-4-5-20251001';
const LINK_SUMMARY_TIMEOUT_MS = 45_000;

export interface SummariseLinkInput {
  requestId: string;
  prompt: string;
  url: string;
  text: string;
  /** cwd for the one-shot SDK session — the host's own home. */
  folder: string;
}

export function buildLinkSummaryPrompt(input: Pick<SummariseLinkInput, 'prompt' | 'url' | 'text'>) {
  return [input.prompt, '', `URL: ${input.url}`, '', 'Page text:', input.text].join('\n');
}

export function makeLinkSummariser(opts: {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
}): (input: SummariseLinkInput) => Promise<string | null> {
  return async function summariseLink(input) {
    return await opts.runOnAccountWithCredit(
      `link summary ${input.requestId}`,
      async (accessToken) => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), LINK_SUMMARY_TIMEOUT_MS);
        try {
          let finalText = '';
          let deltaText = '';
          for await (const env of opts.sdkBackend.run({
            prompt: buildLinkSummaryPrompt(input),
            inferenceProfile: 'classifier',
            cwd: input.folder,
            resumeSessionId: undefined,
            abortController,
            oauthAccessToken: accessToken,
            model: LINK_SUMMARY_MODEL,
            permissionMode: 'bypassPermissions',
          })) {
            if (env.type === 'assistant' && env.content) finalText += env.content;
            else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
            else if (env.type === 'error') {
              // Thrown so the runner can tell a spent account from a real error.
              throw new Error(env.errorMessage ?? 'link summary: SDK error envelope');
            }
          }
          const text = (finalText !== '' ? finalText : deltaText).trim();
          return text === '' ? null : text;
        } finally {
          clearTimeout(timer);
        }
      },
    );
  };
}
