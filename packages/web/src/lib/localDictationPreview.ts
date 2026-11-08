// Dictation on "Parakeet on this computer" (spec/07 § Dictation engines,
// `local`): the desktop app runs the recogniser, so no audio session is opened
// and nothing goes to the host. Same shape as `startDictationPreview` — the
// composer feeds it the microphone's PCM and asks it to finish — so the
// composer treats it as any other streaming engine.
//
// NO FALLBACK: outside the desktop app, or with the models not downloaded, the
// dictation fails with the reason; no other engine reads the words instead.

import { getDesktopBridge } from './desktopBridge.js';
import type { DictationPreview, DictationPreviewCallbacks } from './dictationPreview.js';

export const LOCAL_ENGINE_DESKTOP_ONLY =
  'Parakeet on this computer only runs in the desktop app. Switch Dictation to another engine in Settings → Voice.';

export function startLocalDictationPreview(
  _chatId: string,
  callbacks: DictationPreviewCallbacks,
): DictationPreview {
  const stt = getDesktopBridge()?.localStt;
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  let lastError: string | null = null;
  let ready = false;
  const pending: Int16Array[] = [];
  let started: Promise<void>;

  function report(message: string): void {
    console.error(`[patch-voice] local dictation: ${message}`);
    lastError = message;
    if (!stopped) callbacks.onPreviewError(message);
  }

  if (!stt) {
    started = Promise.resolve();
    report(LOCAL_ENGINE_DESKTOP_ONLY);
  } else {
    started = stt
      .start((ev) => {
        if (stopped) return;
        if (ev.type === 'partial') callbacks.onPartial(ev.text);
        else report(ev.message);
      })
      .then(
        (off) => {
          unsubscribe = off;
          if (stopped) {
            off();
            stt.cancel();
            return;
          }
          ready = true;
          for (const pcm of pending.splice(0)) stt.push(pcm);
        },
        (e: Error) => report(e.message),
      );
  }

  function close(): void {
    unsubscribe?.();
    unsubscribe = null;
  }

  return {
    push(pcm: Int16Array): void {
      if (stopped || !stt || lastError !== null) return;
      if (ready) stt.push(pcm);
      else pending.push(pcm);
    },
    async finish(): Promise<string> {
      if (stopped) throw new Error('the live dictation was already closed');
      await started;
      if (lastError !== null) throw new Error(lastError);
      try {
        return await stt!.finish();
      } catch (e) {
        throw new Error(lastError ?? (e as Error).message);
      }
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      pending.length = 0;
      close();
      if (stt && (ready || lastError === null)) stt.cancel();
    },
  };
}
