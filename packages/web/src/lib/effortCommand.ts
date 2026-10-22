// spec/04-chats-and-folders.md § Effort — `/effort <level>` slash command.
// Typing `/effort <level>` in the composer changes the chat's thinking-effort
// override the same way the picker does (`chat.effort_request` on the live
// socket), without opening it. A bare `/effort` CLEARS the override — unlike
// `/model`, there IS a sensible "no override" state for effort to fall back
// to, the same as `/goal`.
//
// This is a pure parse so it's unit-testable in isolation and the composer's
// send path stays a thin dispatch.

import type { EffortLevel } from '@patch/wire';

const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface EffortCommand {
  /** True when the message is an `/effort` command (and NOT a normal chat turn). */
  isEffort: boolean;
  /** The level to set — `null` clears it. Only meaningful when `isEffort`. */
  effort: EffortLevel | null;
  /**
   * The raw text after the command when it matched no known level — distinct
   * from `null` (clear) so the caller can report what it could not match,
   * rather than silently treating a typo as a clear.
   */
  unknown: string | null;
}

const NOT_EFFORT: EffortCommand = { isEffort: false, effort: null, unknown: null };

/**
 * Parse a composer message. Returns `{ isEffort: true, effort }` when the
 * message is an `/effort` command — `effort` is the matched level, or `null`
 * when nothing followed (a clear) or the text matched no level (`unknown`
 * then carries it). Matched case-insensitively. Any other message →
 * `isEffort: false`.
 */
export function parseEffortCommand(message: string): EffortCommand {
  const m = /^\/effort(?:\s+([\s\S]*))?$/i.exec(message.trim());
  if (!m) return NOT_EFFORT;
  const rest = (m[1] ?? '').trim();
  if (rest.length === 0) return { isEffort: true, effort: null, unknown: null };
  const level = EFFORT_LEVELS.find((l) => l === rest.toLowerCase());
  if (level === undefined) return { isEffort: true, effort: null, unknown: rest };
  return { isEffort: true, effort: level, unknown: null };
}
