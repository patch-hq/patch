// This surface's speech engines for a direct call (spec/07 § Direct calls;
// spec/05 § Speech engines). On-device engines are the desktop app's own —
// Parakeet and Kokoro, once downloaded; a browser has none. Cloud engines are
// the account's, from the keys its hosts hold, and run on the chat's host.
// Every engine is built behind the same interfaces the shared runtime drives.

import {
  CLOUD_STT_ENGINES,
  CLOUD_TTS_ENGINES,
  cloudSpeechEnginesFromHosts,
  mergeSpeechEngines,
  STT_ENGINE_LABEL,
  TTS_ENGINE_LABEL,
  type CloudSttEngine,
  type CloudTtsEngine,
  type ResolvedDirectCall,
  type SpeechEngineReport,
} from '@patch/wire/direct-call';
import {
  cloudSpeechToText,
  cloudTextToSpeech,
  type DirectCallPost,
  type DirectSpeechToText,
  type DirectTextToSpeech,
} from '@patch/wire/direct-call-runtime';
import { getDesktopBridge, type PatchDesktopBridge as DesktopBridge } from '../desktopBridge.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import type { PcmPlayer } from './pcmPlayer.js';

export const PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3';

/** The engines installed on this device. A browser reports none. */
export async function deviceSpeechEngines(
  bridge: DesktopBridge | undefined = getDesktopBridge(),
): Promise<SpeechEngineReport> {
  const report: SpeechEngineReport = { stt: [], tts: [] };
  if (bridge?.localStt && (await bridge.localStt.status()).installed) {
    report.stt.push({ engine: 'parakeet', where: 'device', models: [PARAKEET_MODEL] });
  }
  if (bridge) {
    const s = await bridge.localTts.status();
    if (s.installed) {
      report.tts.push({ engine: 'kokoro', where: 'device', models: [s.model], voices: s.voices });
    }
  }
  return report;
}

/** Every engine this device can run now: its own, then the account's cloud ones. */
export async function currentSpeechEngines(): Promise<SpeechEngineReport> {
  const hosts = Object.values(usePresenceStore.getState().hosts).flatMap((h) =>
    h.host ? [h.host] : [],
  );
  return mergeSpeechEngines(await deviceSpeechEngines(), cloudSpeechEnginesFromHosts(hosts));
}

interface BuildContext {
  chatId: string;
  post: DirectCallPost;
  player: PcmPlayer;
  bridge: DesktopBridge | undefined;
}

function isCloudStt(e: string): e is CloudSttEngine {
  return (CLOUD_STT_ENGINES as readonly string[]).includes(e);
}
function isCloudTts(e: string): e is CloudTtsEngine {
  return (CLOUD_TTS_ENGINES as readonly string[]).includes(e);
}

/** The speech-to-text engine a resolved call names, on this surface. */
export function buildSpeechToText(call: ResolvedDirectCall, ctx: BuildContext): DirectSpeechToText {
  const { engine, model } = call.stt;
  if (isCloudStt(engine))
    return cloudSpeechToText({ post: ctx.post, chatId: ctx.chatId, engine, model });
  const local = ctx.bridge?.localStt;
  if (engine === 'parakeet' && local) {
    return { label: STT_ENGINE_LABEL.parakeet, transcribe: (pcm) => local.read(pcm) };
  }
  throw new Error(`${STT_ENGINE_LABEL[engine]} does not run on this device`);
}

/** The text-to-speech engine a resolved call names, on this surface. */
export function buildTextToSpeech(call: ResolvedDirectCall, ctx: BuildContext): DirectTextToSpeech {
  const { engine, model, voice, sound } = call.tts;
  if (isCloudTts(engine)) {
    return cloudTextToSpeech({
      post: ctx.post,
      chatId: ctx.chatId,
      engine,
      model,
      voice: voice!,
      sound,
      play: (pcm, rate) => ctx.player.prepare(pcm, rate),
    });
  }
  const tts = ctx.bridge?.localTts;
  if (engine === 'kokoro' && tts) {
    return {
      label: TTS_ENGINE_LABEL.kokoro,
      async prepare(text) {
        return ctx.player.prepare(await tts.speak(text, voice!, sound.speed ?? 1), 24000);
      },
    };
  }
  throw new Error(`${TTS_ENGINE_LABEL[engine]} does not run on this device`);
}
