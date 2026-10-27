// A tool_result of "[Tool result missing due to internal error]" is not output:
// it is the Claude runtime's stand-in for a result it never received, and the
// call itself may well have run. It must reach the chat as an error saying so,
// and be logged, rather than look like the tool's own empty answer.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { translateSdkMessage, LOST_TOOL_RESULT } from '../src/sdkBackend.js';

const toolUse = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: {} }],
  },
};
const resultMsg = (content: unknown, isError?: boolean) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  },
});

afterEach(() => vi.restoreAllMocks());

describe('lost tool result', () => {
  it('marks the runtime placeholder as an error that says the call may have run, and logs it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const names = new Map<string, string>();
    translateSdkMessage(toolUse, names);
    const [env] = translateSdkMessage(
      resultMsg('[Tool result missing due to internal error]', true),
      names,
    );
    expect(env?.toolResult?.isError).toBe(true);
    expect(String(env?.toolResult?.result)).toContain('may have run');
    expect(String(env?.toolResult?.result)).toContain(
      '[Tool result missing due to internal error]',
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Write'));
  });

  it('matches the placeholder inside text blocks too', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const [env] = translateSdkMessage(resultMsg([{ type: 'text', text: LOST_TOOL_RESULT }], true));
    expect(env?.toolResult?.isError).toBe(true);
  });

  it('leaves ordinary results alone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const [env] = translateSdkMessage(resultMsg('ok'));
    expect(env?.toolResult?.result).toBe('ok');
    expect(env?.toolResult?.isError).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
