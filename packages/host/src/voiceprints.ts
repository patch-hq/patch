// Voiceprint requests (spec/16 § Who is speaking, spec/03 § Voiceprints).
//
// Settings enrols a person in one of two ways, both answered here: a recorded
// sample turned into a voiceprint (`embed`), or the voices this host's devices
// heard lately (`recent`), one of which the user names. Every outcome, success
// or a typed refusal, is one `patch.voiceprint.response`.

import type { Logger } from 'pino';
import type { PatchVoiceprintRequestEvent, WireEvent } from '@patch/wire';
import {
  SpeakerIdUnavailableError,
  TooShortError,
  type RecentVoices,
  type SpeakerId,
} from './audio/speakerId.js';

export async function handleVoiceprintRequest(
  event: PatchVoiceprintRequestEvent,
  sender: (e: WireEvent) => void,
  logger: Logger,
  hostId: string,
  deps: { speakerId: Pick<SpeakerId, 'embed'>; recent: Pick<RecentVoices, 'list'> },
): Promise<void> {
  const base = { type: 'patch.voiceprint.response' as const, requestId: event.requestId, hostId };
  if (event.op === 'recent') {
    sender({ ...base, ok: true, recent: deps.recent.list() });
    return;
  }
  try {
    if (event.pcm === undefined) throw new TooShortError('no audio was sent');
    const bytes = Buffer.from(event.pcm, 'base64');
    const pcm = new Int16Array(bytes.byteLength >>> 1);
    new Uint8Array(pcm.buffer).set(bytes.subarray(0, pcm.byteLength));
    const voiceprint = await deps.speakerId.embed(pcm);
    sender({
      ...base,
      ok: true,
      voiceprint: voiceprint.map((x) => Math.round(x * 1e5) / 1e5),
      seconds: Number((pcm.length / 16000).toFixed(1)),
    });
  } catch (err) {
    const code =
      err instanceof TooShortError
        ? 'too_short'
        : err instanceof SpeakerIdUnavailableError
          ? 'voice_component_missing'
          : 'internal';
    if (code === 'internal') logger.error({ err }, 'voiceprint failed');
    sender({ ...base, ok: false, error: { code, message: (err as Error).message } });
  }
}
