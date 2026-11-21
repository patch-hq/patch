// A provider's OWN settings (spec/10 § Provider settings; decision 9): values
// the provider itself reads from its own configuration, such as how long it
// keeps a session. Patch shows each and writes the user's choice into the
// provider's own file; it never writes one the user has not chosen, so the
// provider's own value or default stands until they do.
//
// Every value Patch keeps is a number (`providerSettings`), whatever the
// provider writes: a toggle is 0 or 1, a size is megabytes. How the number is
// written into the provider's file is the setting's `write`, so one host-side
// writer serves every provider and none is named in code.

import { z } from 'zod';

/** How a setting's number goes into the provider's own file. */
export const OwnSettingWrite = z.discriminatedUnion('as', [
  /** The number itself. */
  z.object({ as: z.literal('number') }).strict(),
  /** A number of days as a duration string, `<n>d` (Gemini CLI's `maxAge`). */
  z.object({ as: z.literal('days-duration') }).strict(),
  /** A toggle as JSON true / false. */
  z.object({ as: z.literal('boolean') }).strict(),
  /** A toggle as one of two words: `[off, on]` (Codex's `persistence`). */
  z
    .object({ as: z.literal('words'), words: z.tuple([z.string().min(1), z.string().min(1)]) })
    .strict(),
  /** Megabytes as a whole number of bytes. */
  z.object({ as: z.literal('bytes') }).strict(),
]);
export type OwnSettingWrite = z.infer<typeof OwnSettingWrite>;

export const OwnSetting = z
  .object({
    /** The key in `providerSettings`, and the dotted path in the provider's own file. */
    key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/),
    label: z.string().min(1),
    /** One line saying what the setting does, in the provider's terms. */
    description: z.string().min(1),
    /** Days, on/off, or a size in megabytes. */
    kind: z.enum(['days', 'toggle', 'megabytes']),
    min: z.number().int(),
    max: z.number().int(),
    /** What the provider does while the setting is absent from its file; null is "no limit". */
    providerDefault: z.number().int().nullable(),
    write: OwnSettingWrite,
  })
  .strict();
export type OwnSetting = z.infer<typeof OwnSetting>;

/** The words a setting's value is shown in, the same on every surface. */
export function describeOwnSetting(s: OwnSetting, value: number | null): string {
  if (value === null) return 'No limit';
  switch (s.kind) {
    case 'toggle':
      return value === 1 ? 'On' : 'Off';
    case 'megabytes':
      return `${value} MB`;
    case 'days':
      return `${value} ${value === 1 ? 'day' : 'days'}`;
  }
}

/** The value to write into the provider's own file for a chosen number. */
export function ownSettingValue(s: OwnSetting, n: number): number | string | boolean {
  switch (s.write.as) {
    case 'number':
      return n;
    case 'days-duration':
      return `${n}d`;
    case 'boolean':
      return n === 1;
    case 'words':
      return s.write.words[n === 1 ? 1 : 0];
    case 'bytes':
      return n * 1024 * 1024;
  }
}

/** Why a chosen number is not one the setting takes, or null when it is. */
export function invalidOwnSettingValue(s: OwnSetting, n: number): string | null {
  if (s.kind === 'toggle') return n === 0 || n === 1 ? null : `${s.label} is on (1) or off (0)`;
  if (!Number.isInteger(n) || n < s.min || n > s.max) {
    return `${s.label} must be a whole number from ${s.min} to ${s.max}`;
  }
  return null;
}
