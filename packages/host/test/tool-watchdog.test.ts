import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatErrorEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';
import {
  ToolHungError,
  hungMessage,
  protectedFolderIn,
  toolDeadlineMs,
  withToolWatchdog,
} from '../src/toolWatchdog.js';

const bashUse = (args: unknown, callId = 'c1'): SdkEnvelope => ({
  type: 'tool_use',
  tool: { name: 'Bash', args, callId },
  raw: {},
});

async function drain(src: AsyncIterable<SdkEnvelope>): Promise<SdkEnvelope[]> {
  const out: SdkEnvelope[] = [];
  for await (const e of src) out.push(e);
  return out;
}

describe('toolDeadlineMs', () => {
  it('honours the Bash timeout plus grace, capped at the ceiling', () => {
    expect(toolDeadlineMs('Bash', { timeout: 60_000 })).toBe(90_000);
    expect(toolDeadlineMs('Bash', {})).toBe(150_000);
    expect(toolDeadlineMs('Bash', { timeout: 9_999_999 })).toBe(630_000);
  });
  it('leaves background, subagent, MCP and question calls alone', () => {
    expect(toolDeadlineMs('Bash', { run_in_background: true })).toBeUndefined();
    expect(toolDeadlineMs('Task', {})).toBeUndefined();
    expect(toolDeadlineMs('AskUserQuestion', {})).toBeUndefined();
    expect(toolDeadlineMs('mcp__patch__patch_wake_me', {})).toBeUndefined();
  });
});

describe('hungMessage', () => {
  it('names Full Disk Access on a Mac when a guarded folder is touched', () => {
    const args = { command: 'ls ~/Documents' };
    expect(protectedFolderIn(args)).toBe('Documents');
    expect(hungMessage('Bash', 90_000, args, 'darwin')).toMatch(/Full Disk Access/);
  });
  it('does not blame macOS elsewhere or for other paths', () => {
    expect(hungMessage('Bash', 90_000, { command: 'ls ~/Documents' }, 'linux')).not.toMatch(/Disk/);
    expect(hungMessage('Bash', 90_000, { command: 'sleep 999' }, 'darwin')).not.toMatch(/Disk/);
  });
});

describe('withToolWatchdog', () => {
  it('fails a Bash call that outlives its timeout', async () => {
    let t = 0;
    async function* src(): AsyncGenerator<SdkEnvelope> {
      yield bashUse({ command: 'ls ~/Documents', timeout: 1000 });
      await new Promise(() => undefined);
    }
    const run = drain(withToolWatchdog(src(), { now: () => t, pollMs: 5, platform: 'darwin' }));
    await new Promise((r) => setTimeout(r, 20));
    t = 1000 + 30_000 + 1;
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolHungError);
    expect((err as ToolHungError).message).toMatch(/Bash call did not return/);
    expect((err as ToolHungError).message).toMatch(/Full Disk Access/);
  });

  it('passes a call that returns in time', async () => {
    let t = 0;
    async function* src(): AsyncGenerator<SdkEnvelope> {
      yield bashUse({ command: 'ls' });
      t = 10_000;
      yield {
        type: 'tool_result',
        toolResult: { name: 'Bash', callId: 'c1', result: 'x' },
        raw: {},
      };
      t = 10_000_000;
      await new Promise((r) => setTimeout(r, 30));
      yield { type: 'result', content: 'done', raw: {} };
    }
    const out = await drain(withToolWatchdog(src(), { now: () => t, pollMs: 5 }));
    expect(out.map((e) => e.type)).toEqual(['tool_use', 'tool_result', 'result']);
  });

  it('stops the clock while the turn waits on the user', async () => {
    let t = 0;
    let paused = true;
    async function* src(): AsyncGenerator<SdkEnvelope> {
      yield bashUse({ command: 'rm x' });
      await new Promise((r) => setTimeout(r, 60));
      yield { type: 'result', content: 'done', raw: {} };
    }
    const run = drain(withToolWatchdog(src(), { now: () => t, pollMs: 5, paused: () => paused }));
    await new Promise((r) => setTimeout(r, 20));
    t = 10_000_000;
    await new Promise((r) => setTimeout(r, 20));
    paused = false;
    expect((await run).map((e) => e.type)).toEqual(['tool_use', 'result']);
  });
});

describe('a hung tool inside a turn', () => {
  it('surfaces an error to the chat instead of sitting running', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-wd-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-wd-f-')));
    const events: WireEvent[] = [];
    let t = 1_700_000_000_000;
    const backend: SdkBackend = {
      run: () =>
        (async function* (): AsyncGenerator<SdkEnvelope> {
          yield bashUse({ command: 'ls', timeout: 1000 });
          t += 1_000_000;
          await new Promise(() => undefined);
        })(),
    };
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: backend,
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: (e) => events.push(e),
      logger: pino({ level: 'silent' }),
      now: () => t,
      generateChatId: () => 'chat-1',
      toolWatchdogPollMs: 5,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    const errs = events.filter((e): e is ChatErrorEvent => e.type === 'chat.error');
    expect(errs[0]?.error.message).toMatch(/Bash call did not return/);
    daemon.shutdown();
  });
});
