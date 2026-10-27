const COMMAND = /^\/[A-Za-z0-9][\w:-]*(?=\s|$)/;

/**
 * Fold `prefix` (a wake tag, a reminder block) in front of `typed` without
 * burying a leading slash command. Claude Code only expands `/skill` when it is
 * the first thing in the turn, so a prefixed command arrives as plain text and
 * the skill body never reaches the agent. The command stays first and the
 * prefix rides in its args.
 */
export function prefixKeepingCommandFirst(prefix: string, typed: string): string {
  if (prefix === '') return typed;
  const m = COMMAND.exec(typed);
  if (m === null) return prefix + typed;
  return `${m[0]} ${prefix}${typed.slice(m[0].length).trimStart()}`;
}
