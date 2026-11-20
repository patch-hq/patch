// A message Claude Code wrote is not a message the model wrote.
//
// On 2026-09-11 a Foreman turn died on a usage limit. Claude Code, resuming the
// session, injected its own `Continue from where you left off.` and answered it
// with `No response requested.` — `model: "<synthetic>"`, zero input tokens,
// `isApiErrorMessage: false`. Patch rendered that as the assistant's reply, so
// a turn that had produced nothing at all read, on screen, as a turn that had
// answered. A silent success is the one failure mode this app is not allowed.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatMessageEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

/** The exact shape Claude Code emitted, as captured from the live transcript. */
const SYNTHETIC_RAW = {
  type: 'assistant',
  message: {
    role: 'assistant',
    model: '<synthetic>',
    content: [{ type: 'text', text: 'No response requested.' }],
    usage: { input_tokens: 0, output_tokens: 4 },
  },
};

const REAL_RAW = {
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'here you go' }],
    usage: { input_tokens: 1_234, output_tokens: 9 },
  },
};

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-synth-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-synth-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder };
}

const assistantTexts = (events: WireEvent[]): string[] =>
  events
    .filter((e): e is ChatMessageEvent => e.type === 'chat.message')
    .filter((e) => e.role === 'assistant')
    .map((e) => e.content);

describe('synthetic assistant messages', () => {
  it('does not render a CLI-generated reply as the assistant speaking', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess' },
      {
        type: 'assistant',
        content: 'No response requested.',
        sessionId: 'sess',
        raw: SYNTHETIC_RAW,
      },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));

    expect(assistantTexts(events)).not.toContain('No response requested.');
  });

  // Hidden from the agent's voice, not from User: the gap is shown as a muted
  // Claude Code line, so a turn that produced nothing is still visible.
  it('shows the CLI-generated reply as a system line flagged synthetic', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess' },
      {
        type: 'assistant',
        content: 'No response requested.',
        sessionId: 'sess',
        raw: SYNTHETIC_RAW,
      },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));

    const notices = events.filter(
      (e): e is ChatMessageEvent => e.type === 'chat.message' && e.synthetic === true,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ role: 'system', content: 'No response requested.' });
    // A real reply never carries the flag.
    expect(
      events.some(
        (e) => e.type === 'chat.message' && e.role === 'assistant' && e.synthetic === true,
      ),
    ).toBe(false);
  });

  it('still renders a real model reply', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess' },
      { type: 'assistant', content: 'here you go', sessionId: 'sess', raw: REAL_RAW },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));

    expect(assistantTexts(events)).toContain('here you go');
  });

  // The resume placeholder never crosses the SDK stream: Claude Code writes it
  // straight into the session, so the host sees it only as a mirrored entry.
  // It must still show — once, however many ways it arrives.
  it('an envelope with no raw SDK message is not treated as synthetic', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess' },
      { type: 'assistant', content: 'plain reply', sessionId: 'sess' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));

    expect(assistantTexts(events)).toContain('plain reply');
  });
});
