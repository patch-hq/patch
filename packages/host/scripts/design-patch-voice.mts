// One-off: create Patch's own ElevenLabs voice with Voice Design.
//
//   preview: design-patch-voice.mts preview "<description>"   writes mp3s to the out dir
//   save:    design-patch-voice.mts save <generatedVoiceId> "<description>"
//
// Key comes from ELEVEN_LABS_API_KEY (op://Agents/env-shared). Usage is appended
// to the voice ledger at VOICE_LEDGER_PATH. Any failure throws; no fallback.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import { createElevenLabs } from '../src/audio/elevenlabs.js';
import { createVoiceLedger } from '../src/audio/voiceLedger.js';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const ledger = createVoiceLedger(need('VOICE_LEDGER_PATH'));
const eleven = createElevenLabs({
  apiKey: need('ELEVEN_LABS_API_KEY'),
  logger: pino({ level: 'info' }),
  onUsage: (u) => ledger.recordSpeech(u),
});

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'preview' && a) {
  const outDir = need('VOICE_PREVIEW_DIR');
  mkdirSync(outDir, { recursive: true });
  const previews = await eleven.designVoicePreviews(a);
  for (const p of previews) {
    const file = join(outDir, `${p.generatedVoiceId}.mp3`);
    writeFileSync(file, Buffer.from(p.audioBase64, 'base64'));
    console.log(p.generatedVoiceId, file);
  }
} else if (cmd === 'save' && a && b) {
  const voice = await eleven.saveDesignedVoice({
    name: 'Patch',
    description: b,
    generatedVoiceId: a,
  });
  console.log(voice.id, voice.name);
} else {
  throw new Error('usage: preview "<description>" | save <generatedVoiceId> "<description>"');
}
