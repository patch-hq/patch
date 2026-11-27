// A call from the app is always a voice agent call (spec/07 § Two kinds of
// call). For tests about the audio server's own plumbing — sessions, heartbeat,
// hand-over, phone-call bookkeeping — this is a Gemini voice agent whose socket
// opens and goes nowhere: no provider is reached.

import { EventEmitter } from 'node:events';
import type { AudioServerOptions } from '../../src/audio/server.js';
import { fakeVoiceAgentLink } from './fakeVoiceAgentLink.js';

export function fakeVoiceAgent(): Pick<
  AudioServerOptions,
  'geminiApiKey' | 'geminiWsCtor' | 'makeTimeline' | 'voiceAgentLink' | 'getVoiceInstructions'
> {
  return {
    geminiApiKey: 'g-key',
    geminiWsCtor: function () {
      const ws = Object.assign(new EventEmitter(), { send() {}, close() {} });
      queueMicrotask(() => ws.emit('open'));
      return ws;
    } as unknown as AudioServerOptions['geminiWsCtor'],
    makeTimeline: () => ({ userSaid() {}, beginReply: () => ({ append() {}, finish() {} }) }),
    voiceAgentLink: fakeVoiceAgentLink().link,
    getVoiceInstructions: () => 'Be the voice of this chat.',
  };
}
