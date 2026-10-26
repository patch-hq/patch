// Live-transcript session for dictation mode on the phone (spec/07 § Dictation
// mode). Unlike `startDictation`, it owns no microphone: the caller pushes the
// PCM it is already capturing, and gets the host's interim transcript back.
// A failure is reported through `onPreviewError`, never swallowed, and never
// affects the capture it decorates.

import { decodeAudio, type AudioEvent } from '@patch/wire/audio';
import { api } from '../api/rest';
import { audioWsUrl } from '../config';

const SAMPLE_RATE = 16000;

export interface DictationPreview {
  push(pcm: Int16Array): void;
  stop(): void;
}

export function startDictationPreview(
  chatId: string,
  onPartial: (text: string) => void,
  onPreviewError: (message: string) => void,
): DictationPreview {
  let stopped = false;
  let ws: WebSocket | null = null;
  let open = false;
  let reported = false;
  const pending: Int16Array[] = [];

  function report(message: string): void {
    if (stopped || reported) return;
    reported = true;
    console.error(`[patch-voice] live dictation preview: ${message}`);
    onPreviewError(message);
  }
  function send(pcm: Int16Array): void {
    try {
      ws!.send(
        JSON.stringify({
          type: 'audio.pcm16',
          ts: Date.now(),
          sampleRate: SAMPLE_RATE,
          samples: pcm.length,
        }),
      );
      ws!.send(pcm.buffer as ArrayBuffer);
    } catch (e) {
      report((e as Error).message);
    }
  }

  void (async () => {
    try {
      const me = await api.me();
      const tok = await api.voiceToken(chatId, 'voice-note');
      if (stopped) return;
      const socket = new WebSocket(audioWsUrl(tok.audioUrl));
      ws = socket;
      socket.onopen = (): void => {
        if (stopped) {
          socket.close();
          return;
        }
        socket.send(
          JSON.stringify({
            type: 'audio.session_start',
            sessionId: tok.sessionId,
            accountId: me.account.accountId,
            surfaceId: me.surface.surfaceId,
            surfaceKind: 'mobile',
            chatId,
            role: 'voice-note',
            token: tok.token,
            surfaceHasAec: true,
          }),
        );
        open = true;
        for (const p of pending.splice(0)) send(p);
      };
      socket.onmessage = (evt: WebSocketMessageEvent): void => {
        if (typeof evt.data !== 'string' || stopped) return;
        let frame: AudioEvent;
        try {
          frame = decodeAudio(evt.data);
        } catch (e) {
          report(`malformed audio frame: ${(e as Error).message}`);
          return;
        }
        if (frame.type === 'audio.transcript_partial') onPartial(frame.text);
        else if (frame.type === 'audio.error') report(frame.message);
      };
      socket.onerror = (): void => report('the audio connection failed');
      socket.onclose = (): void => report('the audio connection closed');
    } catch (e) {
      report((e as Error).message);
    }
  })();

  return {
    push(pcm: Int16Array): void {
      if (stopped) return;
      if (open) send(pcm);
      else pending.push(pcm);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      pending.length = 0;
      try {
        ws?.send(JSON.stringify({ type: 'audio.session_end', reason: 'cancelled' }));
      } catch {
        // socket never opened or already closed; close below is the source of truth
      }
      ws?.close();
    },
  };
}
