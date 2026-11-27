// The catch-up in a call's start context (spec/07 § Keeping voice and text as
// one conversation): everything in the chat before its last messages, written
// up by a small job (spec/02 § Small jobs) while the call connects, so the
// call never waits for it and it costs only cheap tokens.
//
// It fails loudly: a job no account or model could run rejects, and the call
// shows the failure and carries on with the rest of its start context.

import type { Logger } from 'pino';
import { sdkCredential, type SdkBackend } from '../sdkBackend.js';
import type { RunOnAccountWithCredit } from '../accountFailover.js';
import { runSmallJob } from '../smallJobModels.js';
import type { StartMessage } from './voiceAgent.js';

/** Abort a hung job so it never leaks a warm SDK query. */
const CATCH_UP_TIMEOUT_MS = 30_000;

/** The most of the earlier chat given to the job, newest kept: a long chat's start matters least. */
export const CATCH_UP_INPUT_CHARS = 60_000;

/** The longest one message is shown to the job. */
const PER_MESSAGE_CHARS = 3_000;

export function catchUpPrompt(earlier: StartMessage[]): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const m = earlier[i]!;
    const flat = m.text.replace(/\s+/g, ' ').trim();
    const text = flat.length > PER_MESSAGE_CHARS ? `${flat.slice(0, PER_MESSAGE_CHARS)}…` : flat;
    const line = `${m.role === 'user' ? 'User' : 'Agent'}: ${text}`;
    if (used + line.length > CATCH_UP_INPUT_CHARS) break;
    used += line.length;
    lines.push(line);
  }
  lines.reverse();
  return [
    'Below is the earlier part of a chat between a user and an agent. A voice assistant is about',
    'to talk to the user about this chat and needs to be caught up. Write the catch-up: what the',
    'chat is for, the decisions made, what has been done, what is in progress and what is still',
    'open. Plain sentences, no markdown, at most 200 words. Say only what the chat shows.',
    '',
    ...(lines.length < earlier.length ? ['(The oldest messages are left out.)'] : []),
    ...lines,
  ].join('\n');
}

export function makeVoiceCatchUp(opts: {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  smallJobModels: () => readonly string[];
  /** The folder the job runs in. */
  folderOf: (chatId: string) => string;
  logger?: Logger;
}): (chatId: string, earlier: StartMessage[]) => Promise<string> {
  return async (chatId, earlier) => {
    const text = await runSmallJob(
      opts,
      `voice catch-up ${chatId}`,
      async (accessToken, model, bedrock) => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), CATCH_UP_TIMEOUT_MS);
        try {
          let finalText = '';
          let deltaText = '';
          for await (const env of opts.sdkBackend.run({
            prompt: catchUpPrompt(earlier),
            inferenceProfile: 'classifier',
            cwd: opts.folderOf(chatId),
            resumeSessionId: undefined,
            abortController,
            ...sdkCredential({ accessToken, bedrock }),
            model,
            permissionMode: 'bypassPermissions',
          })) {
            if (env.type === 'assistant' && env.content) finalText += env.content;
            else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
            else if (env.type === 'error') {
              throw new Error(env.errorMessage ?? 'voice catch-up: SDK error envelope');
            }
          }
          const out = (finalText !== '' ? finalText : deltaText).trim();
          if (out === '') throw new Error('the model wrote nothing');
          return out;
        } finally {
          clearTimeout(timer);
        }
      },
    );
    if (text === null) throw new Error('no account could run the catch-up');
    return text;
  };
}
