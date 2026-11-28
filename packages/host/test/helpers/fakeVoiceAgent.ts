// A call from the app is always a voice agent call (spec/07 § Two kinds of
// call). For tests about the audio server's own plumbing — sessions, heartbeat,
// hand-over, phone-call bookkeeping — this is a Gemini voice agent whose socket
// opens and completes setup, and says nothing: no provider is reached.

import { EventEmitter } from 'node:events';
import type { AudioServerOptions } from '../../src/audio/server.js';
import { fakeVoiceAgentLink, emptyToolbox } from './fakeVoiceAgentLink.js';

export function fakeVoiceAgent(): Pick<
  AudioServerOptions,
  | 'geminiApiKey'
  | 'geminiWsCtor'
  | 'makeTimeline'
  | 'voiceAgentLink'
  | 'voiceToolbox'
  | 'getVoiceInstructions'
> {
  return {
    geminiApiKey: 'g-key',
    geminiWsCtor: function () {
      const ws = Object.assign(new EventEmitter(), {
        send(data: string): void {
          if ((JSON.parse(data) as { setup?: unknown }).setup) {
            queueMicrotask(() => ws.emit('message', JSON.stringify({ setupComplete: {} }), false));
          }
        },
        close(): void {},
      });
      queueMicrotask(() => ws.emit('open'));
      return ws;
    } as unknown as AudioServerOptions['geminiWsCtor'],
    makeTimeline: () => ({
      userSaid() {},
      beginReply: () => ({ set() {}, finish() {} }),
    }),
    voiceAgentLink: fakeVoiceAgentLink().link,
    voiceToolbox: emptyToolbox(),
    getVoiceInstructions: () => 'Be the voice of this chat.',
  };
}
