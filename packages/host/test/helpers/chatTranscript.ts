// What a (mock) backend run would find in the chat's own Claude config dir: the
// conversation file Claude resumes in place. Tests that used to read the
// reseed the host handed the SDK read the file the host wrote instead.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SdkRunOptions } from '../../src/sdkBackend.js';
import { encodeFolder } from '../../src/history.js';

export interface TranscriptEntry {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  message?: { role?: string; content?: unknown };
}

/**
 * What the host wrote for the session this run resumes: the conversation file
 * plus whatever it set aside as harness-written (`.stripped`); `[]` when there is none.
 * A seed built from a bare mock chat has no model on its replies, so the strip
 * takes it as harness-written — it is still the host's seed.
 */
export function transcriptFor(
  o: Pick<SdkRunOptions, 'claudeConfigDir' | 'cwd' | 'resumeSessionId'>,
): TranscriptEntry[] {
  if (!o.claudeConfigDir || !o.resumeSessionId) return [];
  const path = join(
    o.claudeConfigDir,
    'projects',
    encodeFolder(o.cwd),
    `${o.resumeSessionId}.jsonl`,
  );
  const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return (read(path) + read(`${path}.stripped`))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TranscriptEntry);
}

export function entryText(e: TranscriptEntry): string {
  return textOf(e.message?.content);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      (b as { type?: string; text?: string }).type === 'text'
        ? ((b as { text?: string }).text ?? '')
        : '',
    )
    .join('');
}

/** Visible user/assistant text in the file, oldest first. */
export function transcriptTexts(o: Parameters<typeof transcriptFor>[0]): string[] {
  return transcriptFor(o)
    .filter((e) => e.type === 'user' || e.type === 'assistant')
    .map((e) => textOf(e.message?.content))
    .filter((t) => t.length > 0);
}
