// A VoiceAgentLink for provider session tests: records what the voice agent's
// tools asked the host for, and answers with fixed text.

import { vi } from 'vitest';
import type { StartContext, SwitchOutcome, VoiceAgentLink } from '../../src/audio/voiceAgent.js';

export const FAKE_START_CONTEXT =
  'THE CHAT AS IT STANDS\nChat: Train times\nUser: what time is my train';

export function fakeVoiceAgentLink(
  opts: {
    startContext?: () => StartContext;
    switchChat?: () => Promise<SwitchOutcome>;
    passToAgent?: VoiceAgentLink['passToAgent'];
  } = {},
): {
  link: VoiceAgentLink;
  passed: Array<{ sessionId: string; chatId: string; request: string }>;
  calls: string[];
} {
  const passed: Array<{ sessionId: string; chatId: string; request: string }> = [];
  const calls: string[] = [];
  const link: VoiceAgentLink = {
    startContext: vi.fn(
      opts.startContext ?? ((): StartContext => ({ text: FAKE_START_CONTEXT, catchUp: null })),
    ),
    passToAgent: vi.fn((req) => {
      calls.push(`pass:${req.request}`);
      passed.push({ sessionId: req.sessionId, chatId: req.chatId, request: req.request });
      opts.passToAgent?.(req);
    }),
    checkStatus: vi.fn((_sessionId: string, chatId: string) => {
      calls.push(`status:${chatId}`);
      return `status of ${chatId}`;
    }),
    lookBack: vi.fn((chatId: string, query: string) => {
      calls.push(`lookBack:${query}`);
      return `found in ${chatId}: dentist on Tuesday`;
    }),
    answerPermission: vi.fn((chatId: string, words: string) => {
      calls.push(`permission:${chatId}:${words}`);
      return false;
    }),
    endCall: vi.fn((sessionId: string) => {
      calls.push(`end:${sessionId}`);
    }),
    switchChat: vi.fn(
      opts.switchChat ??
        (async (): Promise<SwitchOutcome> => ({ ok: false, message: 'No chat matches "x".' })),
    ),
  };
  return { link, passed, calls };
}
