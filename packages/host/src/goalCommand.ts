// `/goal` belongs to Patch, never to Claude Code. Claude Code has its own
// `/goal` that, handed a turn starting with it, sets a goal Patch knows nothing
// about. Surfaces strip the token before sending; this catches every path that
// does not (new-chat first message, CLI, API, voice, queued sends).

const GOAL = /^\/goal(?=\s|$)/i;

export interface LeadingGoal {
  /** The goal to set; null clears it (a bare `/goal`). */
  goal: string | null;
  /** What remains to send as the turn; empty when only the command was typed. */
  message: string;
}

/** Parse a turn that STARTS with `/goal`; null when it does not. */
export function parseLeadingGoal(message: string): LeadingGoal | null {
  const text = message.trim();
  const m = GOAL.exec(text);
  if (m === null) return null;
  const rest = text.slice(m[0].length).trim();
  return { goal: rest.length > 0 ? rest : null, message: rest };
}
