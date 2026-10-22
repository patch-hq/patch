// The composer's built-in slash commands (spec/04 § Goals, § Model; patch/todo.md
// `/remind`; 02-daemon.md § Self-wake `/loop`; `/clear`). Mirrors web's
// ChatRoute `handleSend` + packages/web/src/lib/{goal,reminder,loop,model,clear}Command.ts
// so a command typed on the phone does what it does on web instead of being sent
// to the agent as a chat turn. Each runs INSTEAD of sending a turn, except
// `/goal <text>`, which sets the goal and then sends the text as the turn.

import type { ModelOption } from './models';

export const SLASH_COMMANDS = [
  { name: 'clear', description: 'Clear the visible chat transcript' },
  { name: 'goal', description: 'Set the chat goal; bare /goal clears it' },
  { name: 'remind', description: 'Set the chat reminder; bare /remind clears it' },
  { name: 'loop', description: 'Re-send a message on an interval; bare /loop stops it' },
  { name: 'model', description: 'Change the chat model: /model <name>' },
] as const;

/** The text after `/name`, trimmed; null when nothing followed; undefined when not that command. */
function argOf(name: string, message: string): string | null | undefined {
  const m = new RegExp(`^/${name}(?:\\s+([\\s\\S]*))?$`, 'i').exec(message.trim());
  if (!m) return undefined;
  const rest = (m[1] ?? '').trim();
  return rest.length > 0 ? rest : null;
}

export const parseClear = (message: string): boolean => /^\/clear$/i.test(message.trim());

export type ModelMatch =
  | { status: 'found'; modelId: string }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: string[] };

/** Exact id/label first, then a unique substring; never rounded to a near match. */
export function matchModel(query: string, models: readonly ModelOption[]): ModelMatch {
  const q = query.trim().toLowerCase();
  const exact = models.find((m) => m.id.toLowerCase() === q || m.label.toLowerCase() === q);
  if (exact) return { status: 'found', modelId: exact.id };
  const partial = models.filter(
    (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
  );
  if (partial.length === 1) return { status: 'found', modelId: partial[0]!.id };
  if (partial.length > 1) return { status: 'ambiguous', candidates: partial.map((m) => m.label) };
  return { status: 'not_found' };
}

export interface SlashDeps {
  chatId: string;
  hostId: string | null;
  goal: string | null;
  reminder: string | null;
  setGoal(goal: string | null): void;
  setReminder(reminder: string | null): void;
  clearTimeline(): void;
  chooseModel(modelId: string): void;
  pushError(message: string): void;
  api: {
    setGoal(chatId: string, goal: string | null): Promise<unknown>;
    setReminder(chatId: string, reminder: string | null): Promise<unknown>;
    setLoop(chatId: string, loop: { message: string; every: string } | null): Promise<unknown>;
    models(hostId: string): Promise<{ models: ModelOption[] }>;
  };
}

export type SlashResult = { handled: true } | { handled: false; text: string };

export function runSlashCommand(text: string, d: SlashDeps): SlashResult {
  if (parseClear(text)) {
    d.clearTimeline();
    return { handled: true };
  }

  const goal = argOf('goal', text);
  if (goal !== undefined) {
    const prev = d.goal;
    d.setGoal(goal);
    void d.api.setGoal(d.chatId, goal).catch((e: Error) => {
      d.setGoal(prev);
      d.pushError(`setting goal failed: ${e.message}`);
    });
    return goal === null ? { handled: true } : { handled: false, text: goal };
  }

  const reminder = argOf('remind', text);
  if (reminder !== undefined) {
    const prev = d.reminder;
    d.setReminder(reminder);
    void d.api.setReminder(d.chatId, reminder).catch((e: Error) => {
      d.setReminder(prev);
      d.pushError(`setting reminder failed: ${e.message}`);
    });
    return { handled: true };
  }

  const loop = /^\/loop(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/i.exec(text.trim());
  if (loop) {
    const every = loop[1] ?? null;
    const message = (loop[2] ?? '').trim();
    if (every === null) {
      void d.api.setLoop(d.chatId, null).catch((e: Error) => {
        d.pushError(`stopping loop failed: ${e.message}`);
      });
    } else if (message === '') {
      d.pushError('usage: /loop <interval> <message>');
    } else {
      void d.api.setLoop(d.chatId, { every, message }).catch((e: Error) => {
        d.pushError(`starting loop failed: ${e.message}`);
      });
    }
    return { handled: true };
  }

  const model = argOf('model', text);
  if (model !== undefined) {
    if (model === null) {
      d.pushError('usage: /model <name>');
    } else if (d.hostId === null) {
      d.pushError('model failed: this chat has no machine to read models from');
    } else {
      void d.api
        .models(d.hostId)
        .then((r) => {
          const match = matchModel(model, r.models);
          if (match.status === 'not_found') d.pushError(`model not found: ${model}`);
          else if (match.status === 'ambiguous')
            d.pushError(`"${model}" matches more than one model: ${match.candidates.join(', ')}`);
          else d.chooseModel(match.modelId);
        })
        .catch((e: Error) => d.pushError(`model failed: ${e.message}`));
    }
    return { handled: true };
  }

  return { handled: false, text };
}
