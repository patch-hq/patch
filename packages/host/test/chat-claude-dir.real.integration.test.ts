// A chat's one conversation file, resumed in place, against REAL Claude
// (spec/04 § History). Opt-in — it spends a few cents of Claude tokens:
//
//   PATCH_REAL_CLAUDE=1 pnpm --filter @patch/host exec vitest run test/chat-claude-dir.real.integration.test.ts
//
// What it proves that the mock-backed tests cannot:
//   1. A turn, then a resume, continue the SAME file under the chat's own
//      config dir, and no `claude-resume-*` temp dir is ever created.
//   2. A host that dies mid-`sleep` (a host update) leaves the turn running; the
//      next host carries it to completion and the transcript is continuous.
//   3. A chat whose session lives only in the old per-chat mirror still
//      resumes, migrated once into the chat's own dir.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loadClaudeOAuth } from '@patch/auth';
import {
  chatClaudeDir,
  chatTranscriptPath,
  createClaudeSessionStore,
  legacyMirrorDir,
} from '../src/claudeSessionStore.js';
import { createRealSdkBackend, type SdkEnvelope } from '../src/sdkBackend.js';
import { REAL_CLAUDE_SKIP_REASON, realClaudeEnabled } from './helpers/real-claude.js';

function token(): string | undefined {
  try {
    const c = loadClaudeOAuth();
    return c.expiresAt !== undefined && Date.now() >= c.expiresAt ? undefined : c.accessToken;
  } catch {
    return undefined;
  }
}
const tok = realClaudeEnabled() ? token() : undefined;
const real = tok ? it : it.skip;
const here = dirname(fileURLToPath(import.meta.url));
const MODEL = 'claude-haiku-5-5';

const resumeDirs = (): string[] =>
  readdirSync(tmpdir()).filter((n) => n.startsWith('claude-resume-'));

async function turn(
  prompt: string,
  chatDir: string,
  cwd: string,
  resumeSessionId?: string,
): Promise<{ sessionId: string; text: string }> {
  let sessionId = resumeSessionId;
  let text = '';
  for await (const env of createRealSdkBackend().run({
    prompt,
    cwd,
    chatId: 'real-dir',
    ...(resumeSessionId ? { resumeSessionId } : {}),
    claudeConfigDir: chatClaudeDir(chatDir),
    model: MODEL,
    permissionMode: 'bypassPermissions',
    abortController: new AbortController(),
    oauthAccessToken: tok!,
  }) as AsyncIterable<SdkEnvelope>) {
    if (env.sessionId) sessionId = env.sessionId;
    if (env.type === 'assistant' && env.content) text += env.content;
    if (env.type === 'error') throw new Error(env.errorMessage ?? 'error envelope');
  }
  return { sessionId: sessionId!, text };
}

const entriesOf = (
  p: string,
): Array<{ uuid?: string; parentUuid?: string | null; type?: string }> =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe(`one conversation file per chat, real Claude${realClaudeEnabled() ? '' : ` — SKIPPED, ${REAL_CLAUDE_SKIP_REASON}`}`, () => {
  real(
    '(1) a turn then a resume continue the same file; no claude-resume-* dir appears',
    async () => {
      const chatDir = mkdtempSync(join(tmpdir(), 'patch-real-chat-'));
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'patch-real-cwd-')));
      const word = `mongoose-${randomUUID().slice(0, 6)}`;
      const before = resumeDirs();
      try {
        const one = await turn(`Remember the codeword ${word}. Reply with just: ok`, chatDir, cwd);
        const file = chatTranscriptPath(chatDir, cwd, one.sessionId);
        expect(existsSync(file)).toBe(true);
        const afterOne = entriesOf(file).length;

        const two = await turn(
          'What was the codeword? Reply with just the word.',
          chatDir,
          cwd,
          one.sessionId,
        );
        expect(two.sessionId).toBe(one.sessionId);
        expect(two.text).toContain(word);
        // Same file, grown in place: nothing was copied aside and no second file exists.
        expect(entriesOf(file).length).toBeGreaterThan(afterOne);
        expect(readdirSync(dirname(file)).filter((n) => n.endsWith('.jsonl'))).toEqual([
          `${one.sessionId}.jsonl`,
        ]);
        expect(resumeDirs()).toEqual(before);
      } finally {
        rmSync(chatDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    180_000,
  );

  real(
    '(2) a host that dies mid-sleep leaves the turn running; the next host finishes it, transcript continuous',
    async () => {
      const chatDir = mkdtempSync(join(tmpdir(), 'patch-real-chat-'));
      const turnsDir = mkdtempSync(join(tmpdir(), 'patch-real-turns-'));
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'patch-real-cwd-')));
      const hostScript = resolve(here, 'helpers', 'real-host-turn.ts');
      const runnerScript = resolve(here, '..', 'src', 'bin', 'turn-runner.ts');
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const args = {
        token: tok!,
        cwd,
        claudeConfigDir: chatClaudeDir(chatDir),
        turnsDir,
        runner: { command: process.execPath, args: ['--import', tsx, runnerScript] },
        chatId: 'real-dir',
        prompt:
          'Run this exact shell command with the Bash tool and wait for it: sleep 40 && echo SLEPT-OK. Then reply with just: finished',
        toolName: 'Bash',
      };
      const run = (
        mode: 'start' | 'attach',
        extra: object = {},
      ): Promise<Record<string, unknown>> =>
        new Promise((res, rej) => {
          const p = spawn(
            process.execPath,
            ['--import', tsx, hostScript, mode, JSON.stringify({ ...args, ...extra })],
            {
              stdio: ['ignore', 'pipe', 'inherit'],
            },
          );
          let out = '';
          p.stdout.on('data', (d) => (out += String(d)));
          p.on('exit', (code) => {
            const last = out.trim().split('\n').pop() ?? '';
            if (code !== 0 || last === '')
              return rej(new Error(`host ${mode} exited ${code}: ${out}`));
            res(JSON.parse(last) as Record<string, unknown>);
          });
        });
      try {
        // A chat with a session already (a resume, as a long-running chat is).
        const { sessionId } = await turn('Reply with just: ok', chatDir, cwd);
        const started = await run('start', { sessionId });
        expect(started['detached']).toBe(1);
        const file = chatTranscriptPath(chatDir, cwd, sessionId);
        // The host is gone; the turn must still be running under its runner.
        const info = JSON.parse(
          readFileSync(join(turnsDir, 'real-dir', 'runner.json'), 'utf8'),
        ) as {
          pid: number;
          claudePid: number | null;
        };
        expect(() => process.kill(info.claudePid ?? info.pid, 0)).not.toThrow();
        const sizeAtDeath = existsSync(file) ? entriesOf(file).length : 0;

        const finished = await run('attach', { sessionId });
        expect(finished['done']).toBe(true);
        expect(finished['sawToolResult']).toBe(true);
        expect(String(finished['text']).toLowerCase()).toContain('finished');

        const all = entriesOf(file);
        expect(all.length).toBeGreaterThan(sizeAtDeath);
        expect(JSON.stringify(all)).toContain('SLEPT-OK');
        // Continuous: every entry's parent is an entry that is in the file.
        const uuids = new Set(all.map((e) => e.uuid).filter(Boolean));
        for (const e of all) if (e.parentUuid) expect(uuids.has(e.parentUuid)).toBe(true);
        expect(resumeDirs().filter((d) => d.includes('real-dir'))).toEqual([]);
      } finally {
        rmSync(chatDir, { recursive: true, force: true });
        rmSync(turnsDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    300_000,
  );

  real(
    '(3) a chat whose session lives only in the old mirror still resumes, migrated once',
    async () => {
      const chatDir = mkdtempSync(join(tmpdir(), 'patch-real-chat-'));
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'patch-real-cwd-')));
      const word = `heron-${randomUUID().slice(0, 6)}`;
      const sessionId = randomUUID();
      const log = pino({ level: 'silent' });
      try {
        // An old chat: its conversation exists only in native/claude, as the old store wrote it.
        const { toClaudeSessionEntries } = await import('../src/nativeReconstruct.js');
        const seeded = toClaudeSessionEntries(
          [
            {
              record: { seq: 0, at: 1 },
              event: {
                type: 'chat.message',
                chatId: 'x',
                role: 'user',
                content: `The codeword is ${word}.`,
                seq: 0,
              },
            },
            {
              record: { seq: 1, at: 2 },
              event: {
                type: 'chat.message',
                chatId: 'x',
                role: 'assistant',
                content: 'Noted.',
                seq: 1,
              },
            },
          ],
          { sessionId, folder: cwd, model: MODEL },
        );
        mkdirSync(legacyMirrorDir(chatDir), { recursive: true });
        writeFileSync(
          join(legacyMirrorDir(chatDir), `${sessionId}.jsonl`),
          seeded.map((e) => JSON.stringify(e)).join('\n') + '\n',
        );

        const store = createClaudeSessionStore({
          chatId: 'real-dir',
          folder: cwd,
          chatDir,
          claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-real-shared-')),
          logger: log,
        });
        await store.prepare(sessionId);
        const file = chatTranscriptPath(chatDir, cwd, sessionId);
        expect(existsSync(file)).toBe(true);

        const r = await turn(
          'What is the codeword? Reply with just the word.',
          chatDir,
          cwd,
          sessionId,
        );
        expect(r.sessionId).toBe(sessionId);
        expect(r.text).toContain(word);
        // Migrated once: the old mirror is left as it was, the live file grew.
        expect(
          readFileSync(join(legacyMirrorDir(chatDir), `${sessionId}.jsonl`), 'utf8')
            .split('\n')
            .filter(Boolean),
        ).toHaveLength(seeded.length);
        expect(entriesOf(file).length).toBeGreaterThan(seeded.length);
      } finally {
        rmSync(chatDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
