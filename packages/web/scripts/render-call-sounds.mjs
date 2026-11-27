#!/usr/bin/env node
// Render the call sounds (spec/07 § Call sounds) to WAV files for the phone.
//
// The web app synthesises them in the page from src/lib/callSoundSynth.ts. The
// phone plays files, so this renders that same module in Chromium's
// OfflineAudioContext — the same engine the web app plays them with — and
// writes one 16-bit mono WAV per sound into apps/mobile/assets/sounds. A
// looping sound is one cycle long, so the phone loops it seamlessly.
//
//   node packages/web/scripts/render-call-sounds.mjs
//
// Run it after changing callSoundSynth.ts; the files are committed.

import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const synth = join(here, '../src/lib/callSoundSynth.ts');
const out = join(here, '../../../apps/mobile/assets/sounds');
const SAMPLE_RATE = 22050;

const bundle = await build({
  entryPoints: [synth],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'callSoundSynth',
  target: 'es2020',
});

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>render</title>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const rendered = await page.evaluate(async (rate) => {
    const { CALL_SOUND_NAMES, renderCallSound } = window.callSoundSynth;
    const result = {};
    for (const name of CALL_SOUND_NAMES) {
      const buf = await renderCallSound(name, rate);
      result[name] = Array.from(buf.getChannelData(0));
    }
    return result;
  }, SAMPLE_RATE);
  for (const [name, samples] of Object.entries(rendered)) {
    const file = join(out, `call_${name.replace(/-/g, '_')}.wav`);
    writeFileSync(file, wav(samples, SAMPLE_RATE));
    console.log(`${file}  ${(samples.length / SAMPLE_RATE).toFixed(2)}s`);
  }
} finally {
  await browser.close();
}

function wav(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => {
    const clamped = Math.max(-1, Math.min(1, v));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  });
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
