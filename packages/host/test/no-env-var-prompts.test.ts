// Patch never asks a person to set an environment variable (spec/02 § Provider
// keys): every key and setting is given inside the app. Any message that reaches
// a user, or an agent relaying one, names the Settings page instead.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { voiceKeyHostStatus, voiceKeyMissingMessage } from '@patch/wire/audio';

const ENV_NAME = /\b[A-Z][A-Z0-9]*_(?:API_)?(?:KEY|TOKEN)\b|\.env\b|env var/i;
// An env name read as `env['X']` is configuration plumbing, not a message.
const ENV_LOOKUP = /env\[['"][A-Z0-9_]+['"]\]/g;

const AUDIO_SRC = join(__dirname, '..', 'src', 'audio');

function stringLiterals(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
    .replace(ENV_LOOKUP, '');
  return code.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"/g) ?? [];
}

describe('no env-var prompts', () => {
  test('the missing-key sentences name Settings → Providers, never an env var', () => {
    const messages = [
      voiceKeyMissingMessage('dictation', 'deepgram'),
      voiceKeyMissingMessage('call', 'gemini'),
      voiceKeyMissingMessage('hands-free', 'openai'),
      ...(['gemini', 'openai', 'deepgram'] as const).map(
        (b) =>
          voiceKeyHostStatus(b, [
            { hostName: 'hetzner', voiceKeys: { gemini: false, openai: false, deepgram: false } },
          ]) ?? '',
      ),
    ];
    for (const m of messages) {
      expect(m).not.toMatch(ENV_NAME);
      expect(m.length).toBeGreaterThan(0);
    }
    expect(voiceKeyMissingMessage('dictation', 'deepgram')).toContain('Settings → Providers');
  });

  test('no string in the audio sources asks for an env var', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(AUDIO_SRC).filter((f) => f.endsWith('.ts'))) {
      for (const lit of stringLiterals(readFileSync(join(AUDIO_SRC, file), 'utf8'))) {
        if (ENV_NAME.test(lit)) offenders.push(`${file}: ${lit.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
