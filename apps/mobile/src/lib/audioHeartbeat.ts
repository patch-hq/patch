// Every audio session on the phone answers the host's heartbeat, whatever kind
// of session it is (a call, dictation, a voice note's live words, a spoken
// alert): the host judges this device by what it hears from it, and a session
// with no microphone has nothing else to say (spec/07 § A dropped call comes back).

import { heartbeatEcho, type AudioEvent } from '@patch/wire/audio';

/**
 * Send the echo for `frame` if it is a heartbeat and the socket is open. A send
 * that fails is logged: the socket is going, and its close is what the session
 * acts on.
 */
export function answerHeartbeat(
  ws: { readonly readyState: number; send(data: string): void },
  frame: AudioEvent,
): void {
  if (frame.type !== 'audio.heartbeat' || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(heartbeatEcho(frame)));
  } catch (e) {
    console.log(`[patch-voice] heartbeat echo send failed: ${(e as Error).message}`);
  }
}
