// Agents calling you and Pause when quiet for (spec/07 § Agent-initiated voice,
// § Pause): new shared settings an older server's snapshot does not carry.

import { describe, expect, it } from 'vitest';
import { AudioSessionStartEvent } from '../src/audio.js';
import {
  ChatCallRequestEvent,
  DEFAULT_SHARED_SETTINGS,
  NotifyEvent,
  PAUSE_WHEN_QUIET_CHOICES,
  SharedSettings,
  SharedSettingsPatch,
} from '../src/index.js';

describe('agent call settings', () => {
  it('default: agents can call, nothing answers on its own, calls never pause on silence', () => {
    expect(DEFAULT_SHARED_SETTINGS.agentsCanCall).toBe(true);
    expect(DEFAULT_SHARED_SETTINGS.agentCallAutoAnswer).toBe(false);
    expect(DEFAULT_SHARED_SETTINGS.pauseWhenQuietMinutes).toBe(0);
  });

  it('a snapshot from a server older than them still reads, with the defaults', () => {
    const {
      agentsCanCall: _a,
      agentCallAutoAnswer: _b,
      pauseWhenQuietMinutes: _c,
      ...older
    } = DEFAULT_SHARED_SETTINGS;
    const parsed = SharedSettings.parse(older);
    expect(parsed.agentsCanCall).toBe(true);
    expect(parsed.agentCallAutoAnswer).toBe(false);
    expect(parsed.pauseWhenQuietMinutes).toBe(0);
  });

  it('a write that does not name them leaves them alone', () => {
    expect(SharedSettingsPatch.parse({ addressWord: 'hey' })).toEqual({ addressWord: 'hey' });
  });

  it('Pause when quiet for is one of the offered choices', () => {
    expect(PAUSE_WHEN_QUIET_CHOICES).toEqual([0, 2, 5, 10, 30]);
    for (const m of PAUSE_WHEN_QUIET_CHOICES) {
      expect(SharedSettingsPatch.parse({ pauseWhenQuietMinutes: m })).toEqual({
        pauseWhenQuietMinutes: m,
      });
    }
    expect(SharedSettingsPatch.safeParse({ pauseWhenQuietMinutes: 7 }).success).toBe(false);
  });
});

describe('agent call wire fields', () => {
  it('a ring can ask to be answered on its own; absent, it rings', () => {
    const base = { type: 'chat.call_request', callId: 'k', chatId: 'c' } as const;
    expect(ChatCallRequestEvent.parse(base).autoAnswer).toBeUndefined();
    expect(ChatCallRequestEvent.parse({ ...base, autoAnswer: true }).autoAnswer).toBe(true);
    expect(
      NotifyEvent.parse({
        type: 'notify',
        chatId: 'c',
        message: '',
        kind: 'call',
        callId: 'k',
        autoAnswer: true,
      }).autoAnswer,
    ).toBe(true);
  });

  it("a session answering an agent's ring carries the reason", () => {
    const start = AudioSessionStartEvent.parse({
      type: 'audio.session_start',
      sessionId: 's',
      accountId: 'a',
      surfaceId: 'sf',
      surfaceKind: 'mobile',
      chatId: 'c',
      role: 'voice-call',
      token: 't',
      surfaceHasAec: true,
      callReason: 'Need a decision',
    });
    expect(start.callReason).toBe('Need a decision');
  });
});
