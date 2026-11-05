// A stand-in for the host process in the real-Claude durable-turn test: it runs
// one real Claude turn under a detached runner, and either dies mid-tool-call
// (a host update; `start`) or carries the turn on from a previous host
// (`attach`). Spawned by chat-claude-dir.real.integration.test.ts.
//
// Usage: tsx real-host-turn.ts <start|attach> <json args>

import { detachDurableTurns, inspectTurn } from '../../src/durableTurn.js';
import { createRealSdkBackend } from '../../src/sdkBackend.js';

const [mode, raw] = process.argv.slice(2);
const a = JSON.parse(raw!) as {
  token: string;
  cwd: string;
  claudeConfigDir: string;
  turnsDir: string;
  runner: { command: string; args: string[] };
  chatId: string;
  sessionId?: string;
  prompt: string;
  toolName: string;
};
const config = { turnsDir: a.turnsDir, runner: a.runner };
const log = { info: () => undefined, warn: () => undefined, error: console.error };

const consumed = mode === 'attach' ? (inspectTurn(config, a.chatId)?.consumed ?? null) : undefined;
let sessionId: string | undefined = a.sessionId;
let text = '';
let sawToolResult = false;
for await (const env of createRealSdkBackend().run({
  prompt: a.prompt,
  cwd: a.cwd,
  chatId: a.chatId,
  ...(a.sessionId ? { resumeSessionId: a.sessionId } : {}),
  claudeConfigDir: a.claudeConfigDir,
  model: 'claude-haiku-5-5',
  permissionMode: 'bypassPermissions',
  abortController: new AbortController(),
  oauthAccessToken: a.token,
  durableTurn: {
    config,
    chatId: a.chatId,
    log,
    ...(mode === 'attach' ? { attach: { consumed } } : {}),
  },
})) {
  if (env.sessionId) sessionId = env.sessionId;
  if (env.type === 'tool_use' && env.tool?.name === a.toolName && mode === 'start') {
    // The host is being replaced while the tool runs: let go of the turn, die.
    process.stdout.write(JSON.stringify({ detached: detachDurableTurns(), sessionId }) + '\n');
    process.exit(0);
  }
  if (env.type === 'tool_result') sawToolResult = true;
  if (env.type === 'assistant' && env.content) text += env.content;
  if (env.type === 'error') throw new Error(env.errorMessage ?? 'error envelope');
}
process.stdout.write(JSON.stringify({ done: true, sessionId, text, sawToolResult }) + '\n');
