// A permission mode chosen while a turn is running must reach that turn's
// Claude Code process ("Approve & resume bypass" on a plan-mode card used to
// change only the displayed mode, so the next tool call asked again).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const setPermissionMode = vi.fn(async () => undefined);
let release: () => void = () => undefined;
let capturedOptions: { canUseTool?: (...a: unknown[]) => Promise<unknown> } = {};

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: typeof capturedOptions }) => {
    capturedOptions = args.options;
    const gate = new Promise<void>((r) => (release = r));
    return {
      setPermissionMode,
      async *[Symbol.asyncIterator]() {
        await gate;
        yield { type: 'result', subtype: 'success', is_error: false, result: 'done' };
      },
    };
  },
}));

import { createRealSdkBackend, setLiveRunPermissionMode } from '../src/sdkBackend.js';

beforeEach(() => setPermissionMode.mockClear());

describe('setLiveRunPermissionMode', () => {
  it('does nothing when the chat has no turn running', async () => {
    await setLiveRunPermissionMode('nobody', 'bypassPermissions');
    expect(setPermissionMode).not.toHaveBeenCalled();
  });

  it('moves the running process, and an approved ExitPlanMode lands on the new mode', async () => {
    const backend = createRealSdkBackend();
    const it = backend
      .run({
        prompt: 'hi',
        cwd: '/tmp',
        chatId: 'c1',
        permissionMode: 'plan',
        abortController: new AbortController(),
        onPermissionRequest: async () => ({ approve: true }),
      } as never)
      [Symbol.asyncIterator]();
    const first = it.next();
    await vi.waitFor(() => expect(capturedOptions.canUseTool).toBeDefined());

    await setLiveRunPermissionMode('c1', 'bypassPermissions');
    expect(setPermissionMode).toHaveBeenCalledWith('bypassPermissions');

    const allowed = (await capturedOptions.canUseTool!('ExitPlanMode', {}, {})) as {
      updatedPermissions?: { mode: string }[];
    };
    expect(allowed.updatedPermissions?.[0]?.mode).toBe('bypassPermissions');

    release();
    await first;
    while (!(await it.next()).done);
    await setLiveRunPermissionMode('c1', 'plan');
    expect(setPermissionMode).toHaveBeenCalledTimes(1);
  });
});
