// patch/todo.md — `/goal` slash command. Typing `/goal <text>` in the composer
// sets the chat's goal instead of sending a message; the goal then shows at the
// top of the chat (GoalBanner). A bare `/goal` (no text) CLEARS the goal.
//
// This is a pure parse so it's unit-testable in isolation and the composer's
// send path stays a thin dispatch. `/goal` is matched case-insensitively on the
// command word only; the goal text itself is preserved verbatim (trimmed).

export interface GoalCommand {
  /** True when the message is a `/goal` command (and NOT a normal chat turn). */
  isGoal: boolean;
  /** The goal to set — `null` clears it. Only meaningful when `isGoal`. */
  goal: string | null;
  /**
   * The message to send as the turn: the input with the `/goal` token removed.
   * Empty when nothing but the command was typed. Only meaningful when `isGoal`.
   */
  message: string;
}

const NOT_GOAL: GoalCommand = { isGoal: false, goal: null, message: '' };

/**
 * Parse a composer message. `/goal` is a command wherever it appears as its own
 * word (start of the message or after whitespace). The goal is the text after
 * it (`null` when nothing follows — a clear); text before it stays part of the
 * message sent. Any message without a `/goal` word → `isGoal: false`.
 */
export function parseGoalCommand(message: string): GoalCommand {
  const text = message.trim();
  const m = /(^|\s)\/goal(?=\s|$)/i.exec(text);
  if (!m) return NOT_GOAL;
  const before = text.slice(0, m.index + m[1]!.length).trim();
  const rest = text.slice(m.index + m[0].length).trim();
  return {
    isGoal: true,
    goal: rest.length > 0 ? rest : null,
    message: [before, rest].filter((x) => x.length > 0).join(' '),
  };
}

/** The built-in command entry for the slash-command autocomplete dropdown. */
export const GOAL_COMMAND_NAME = 'goal';
export const GOAL_COMMAND_DESCRIPTION = 'Set the chat goal; bare /goal clears it';
