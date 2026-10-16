// lib/hooksEditor.ts — what a hook form may be saved as.

import { describe, it, expect } from 'vitest';
import { blankDraft, canSave, draftToBody } from '../src/lib/hooksEditor';

const script = (timeoutMs: string) => ({
  ...blankDraft(),
  name: 'tone',
  kind: 'script' as const,
  command: 'check.sh',
  timeoutMs,
});

describe('hook timeout', () => {
  it.each([[''], ['   '], ['30000'], [' 500 ']])('%j can be saved', (t) => {
    expect(canSave(script(t))).toBe(true);
  });

  it.each([['30s'], ['0'], ['-5'], ['1.5'], ['1e3'], ['abc']])(
    '%j cannot be saved — it would go out as null or a non-timeout',
    (t) => {
      expect(canSave(script(t))).toBe(false);
    },
  );

  it('is sent as a number, trimmed, or left out when blank', () => {
    expect(draftToBody(script(' 500 ')).timeoutMs).toBe(500);
    expect(draftToBody(script('  ')).timeoutMs).toBeUndefined();
  });
});
