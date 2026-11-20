// Helpers shared by the host's turn path, and the check that a provider session
// still exists.
//
// Patch never reads a provider's session for display (spec/04 § History): what
// a chat shows comes from Patch's own record. What is left here is the folder
// encoding Claude Code uses for its session store, the user-message
// normalisation the live stream applies, the translation of Claude Code's own
// provider-level context, and `SessionProbe`, which answers only whether a
// session can still be resumed.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { splitLeadingNotes, type NoteItem } from './notes.js';
import { findTranscript } from './claudeSessionStore.js';

/** Whether a chat's provider session can still be resumed. */
export interface SessionProbe {
  /**
   * Pass `chatDir` for a Claude session: each chat's session lives in its own
   * config dir, not the shared one.
   */
  hasSession(opts: { folder: string; sessionId: string; chatDir?: string }): boolean;
}

export interface ClaudeSessionProbeOptions {
  /** Override ~/.claude/projects — used by tests. */
  claudeProjectsRoot?: string;
}

/**
 * Claude Code sessions: one exists when Claude Code has written its file. A
 * freshly started session reports its id before the file lands, so "no file"
 * there means nothing to resume yet. Only existence is checked; the file is
 * never read.
 */
export function createClaudeSessionProbe(opts: ClaudeSessionProbeOptions = {}): SessionProbe {
  const root = opts.claudeProjectsRoot ?? defaultClaudeProjectsRoot();
  return {
    hasSession({ folder, sessionId, chatDir }) {
      if (chatDir !== undefined) {
        return findTranscript({ chatDir, folder, sessionId, claudeProjectsRoot: root }) !== null;
      }
      return existsSync(join(root, encodeFolder(folder), `${sessionId}.jsonl`));
    },
  };
}

/**
 * A provider whose agent keeps its session where Patch does not look (an ACP
 * agent such as Gemini CLI). A session the chat names is the agent's to resume:
 * if it is gone, the agent's own refusal says so on the next turn. Answering
 * "no session" here would make every turn after the first drop the session and
 * start over, and host cleanup treat the chat as lost.
 */
export const agentHeldSession: SessionProbe = {
  hasSession: ({ sessionId }) => sessionId.length > 0,
};

export function defaultClaudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Encode an absolute folder path into Claude Code's projects-dir name. */
export function encodeFolder(folder: string): string {
  // Mirrors the bundled claude-agent-sdk exactly: every non-alphanumeric
  // becomes '-'; past 200 chars it keeps the first 200 and appends a base-36
  // hash of the original path.
  const encoded = folder.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let i = 0; i < folder.length; i++) hash = ((hash << 5) - hash + folder.charCodeAt(i)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Payload identity of a logged event — the key that says "this is the same
 * event" when a provider sends it again (a resumed turn replaying what it
 * already said). `null` for events with no stable payload of their own.
 */
export function eventIdentity(ev: WireEvent): string | null {
  switch (ev.type) {
    case 'chat.message':
      return `message ${ev.role} ${ev.content}`;
    // A tool-call id is minted by the model and unique per call, so it is a
    // stronger identity than the args — and the JSONL tool_result block carries
    // no tool name (we substitute a placeholder below), so callId is the ONLY
    // usable key there.
    case 'chat.tool_call':
      return `tool_call ${ev.callId}`;
    case 'chat.tool_result':
      return `tool_result ${ev.callId}`;
    // Claude Code's own provider-level context (`jsonlLineToWire`'s
    // `type === 'attachment'` branch) — no id of its own, so keyed on its
    // translated payload the same way a chat.message is.
    case 'chat.provider_context':
      return `provider_context ${ev.providerType} ${ev.text}`;
    // A note to the agent (notes.ts) — its own entry, keyed on what it says.
    case 'chat.note':
      return `note ${ev.label} ${ev.text}`;
    default:
      return null;
  }
}

/**
 * Hash of a payload identity (`eventIdentity`), so a key built from one stores
 * no message text.
 */
export function identityHash(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 22);
}

/**
 * A slash-command / skill invocation, as Claude Code will have rewritten it by
 * the time this module reads it back. The host's outgoing prompt is the plain
 * text a user typed (`/plant nettle`) or the text the server rendered for a job
 * (`/ha-update\n\n<body>` — packages/server/src/jobs/dispatcher.ts
 * renderPrompt). Claude Code does NOT persist that: it writes a
 * <command-message>/<command-name>/<command-args> wrapper whose args are
 * everything after the command name, TRIMMED. The separator that followed the
 * name and any surrounding whitespace are gone from disk, so `read()` — which
 * unwraps via `sanitizeCommandText` — can only ever hand back the normalised
 * `/name args` form. `null` when the prompt is not a command invocation at all.
 *
 * The name must be a command NAME, not a bare leading slash: an absolute path
 * (`/srv/patch/CONTEXT.md`) is not an invocation, Claude Code persists it
 * verbatim, and normalising it would break the identity it already has.
 */
function normaliseCommandInvocation(text: string): string | null {
  const match = /^\/([A-Za-z0-9][\w:-]*)(?=\s|$)/.exec(text);
  if (match === null) return null;
  const name = match[1] as string;
  const args = text.slice(match[0].length).trim();
  return args.length > 0 ? `/${name} ${args}` : `/${name}`;
}

/**
 * The user turn as the record shows it: the host's outgoing prompt with Patch's
 * leading notes and any command wrapper taken off, and a slash-command
 * invocation reduced to its normalised `/name args` form (the form Claude Code
 * stores it in, so the record and the provider agree on what was asked).
 * `null` for a turn that is only a command's output.
 */
export function persistedUserContent(prompt: string): string | null {
  const cleaned = sanitizeCommandText(prompt);
  if (cleaned === null) return null;
  // Not a command invocation => Claude Code persists the text verbatim, so the
  // verbatim text IS the persisted form. Nothing is being guessed at here.
  const command = normaliseCommandInvocation(cleaned);
  return command === null ? cleaned : command;
}

/**
 * LEGACY. Transcripts written before notes carried their own label hold Patch's
 * notes as `<system-reminder>` blocks. This names one from its inner text so an
 * old chat still replays its notes as labelled entries; nothing writes the
 * old form any more. Matched on a stable substring of
 * each site's own wording (`chatRunner.ts` / `todos.ts` / `specialThreads.ts`)
 * rather than the whole string, so a wording tweak that keeps the substring
 * keeps the label. The pending-decision variant of the restart reminder is
 * checked before the plain one because both share the phrase "cut off
 * partway"; the fire/edit variants of the todo reminder both share "task
 * list". An unrecognised block (every leading `<system-reminder>` today is
 * one of Patch's own six builders, the newest being an `agent_response`
 * hook's deferred `advise` — spec/20-hooks.md § On the agent's response)
 * still surfaces under a generic label rather than being silently dropped.
 */
function labelSystemReminder(text: string): string {
  if (text.includes('and was waiting for an answer')) {
    return 'Turn interrupted by restart (pending decision)';
  }
  if (text.includes('cut off partway')) return 'Turn interrupted by restart';
  if (text.includes("this chat's task list")) {
    return text.includes('fired from') ? 'Todo item fired' : 'Todo list updated';
  }
  if (text.includes('Reminder set on this chat by the user')) return 'Reminder';
  if (text.includes('goal has been set on this chat')) return 'Goal set';
  if (text.includes("chat's goal has been cleared")) return 'Goal cleared';
  if (text.includes('Recent broadcasts delivered on this thread')) return 'Broadcast digest';
  if (text.includes('left a comment on')) return 'New comment';
  if (text.includes('since you last saw it')) return 'Document edited';
  if (text.includes('talked to this chat by voice')) return 'Voice conversation';
  if (text.includes('could not be run on your last reply')) return 'Hook failed';
  if (text.includes('agent_response hook')) return 'Hook advice';
  if (/^A meeting is .* in this chat/.test(text)) return 'Meeting context';
  return 'System context';
}

/**
 * Split the notes off the front of a user turn's text (notes.ts), so each
 * replays as its own `chat.note` entry ahead of the message. Reads the current
 * `[Note: …]` form and, for transcripts written before it, the old leading
 * `<system-reminder>` blocks. Only leading blocks: a user who writes the same
 * words mid-message keeps them.
 */
function extractLeadingNotes(text: string): { cleaned: string; items: NoteItem[] } {
  const items: NoteItem[] = [];
  let rest = text;
  for (;;) {
    const current = splitLeadingNotes(rest);
    if (current.notes.length > 0) {
      items.push(...current.notes);
      rest = current.rest;
      continue;
    }
    const legacy = /^<system-reminder>([\s\S]*?)<\/system-reminder>\s*/.exec(rest);
    if (!legacy) break;
    const inner = (legacy[1] ?? '').trim();
    if (inner.length > 0) items.push({ label: labelSystemReminder(inner), text: inner });
    rest = rest.slice(legacy[0].length);
  }
  return { cleaned: rest, items };
}

/**
 * Human label for one of Claude Code's own provider-level attachment types
 * (spec/02 § Provider-level context) — the counterpart to `labelSystemReminder`
 * above, but keyed on the SDK's own `attachment.type` rather than matched by
 * wording, since these are structured, not free text. A `providerType` this
 * repo has never seen still gets a legible label (Title Case of the raw type)
 * rather than being dropped — Claude Code adding a new attachment kind some
 * future release must not go silently missing here.
 */
const PROVIDER_CONTEXT_LABELS: Record<string, string> = {
  environment: 'Environment',
  model: 'Model',
  date: 'Date',
  instructions: 'Instructions changed',
  session_context: 'Session context',
  remote_session_change: 'Attribution changed',
  skill_listing: 'Skills available',
  agent_listing_delta: 'Agents available',
  deferred_tools_delta: 'Tools available',
  command_permissions: 'Command permissions',
  prompt_snapshot: 'System prompt snapshot',
  total_tokens_reminder: 'Tokens remaining',
  deferred_tools_record: 'Tool-call bookkeeping',
  // A file the agent had read changed on disk outside it (the user, an editor, a
  // linter, another chat) — Claude Code tells the agent so on its next turn.
  edited_text_file: 'File changed externally',
  edited_image_file: 'Image changed externally',
};

function providerContextLabel(providerType: string): string {
  const known = PROVIDER_CONTEXT_LABELS[providerType];
  if (known) return known;
  return providerType
    .split('_')
    .filter((w) => w.length > 0)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The human-readable text of a `<system-reminder>`-shaped `rendered` block —
 * the same wrapper `extractLeadingNotes` strips off Patch's own
 * reminders. Claude Code renders most of its native attachments through the
 * identical tag, so the same unwrap applies.
 */
function unwrapRenderedReminder(content: string): string {
  const match = /^<system-reminder>([\s\S]*?)<\/system-reminder>\s*$/.exec(content.trim());
  return (match ? (match[1] ?? '') : content).trim();
}

/**
 * Best-effort human text for an attachment carrying no `rendered` block at
 * all (today: `command_permissions`, `prompt_snapshot`, `deferred_tools_record`
 * — pure internal bookkeeping Claude Code never renders as a reminder to the
 * model itself). Never a raw JSON dump (spec/14 — no decorative noise), but
 * honest about not fully understanding the shape rather than inventing prose.
 */
function fallbackProviderContextText(attachment: Record<string, unknown>): string {
  const entries = Object.entries(attachment).filter(([k]) => k !== 'type');
  if (entries.length === 0) return '(no further detail)';
  return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
}

/**
 * Claude Code's OWN provider-level context (spec/02 § Provider-level context)
 * — a `type: "attachment"` transcript entry, structurally unrelated to
 * Patch's notes to the agent (`extractLeadingNotes`
 * above): each is its own top-level JSONL line, never embedded in a turn's
 * prompt. `null` only when the line calls itself an attachment but carries no
 * usable `attachment.type` — a shape this reader cannot even name, as opposed
 * to one it doesn't specifically recognise (which still gets a generic label,
 * never dropped).
 */
export function translateAttachment(
  obj: Record<string, unknown>,
): { providerType: string; label: string; text: string } | null {
  const attachment = obj['attachment'];
  if (typeof attachment !== 'object' || attachment === null) return null;
  const a = attachment as Record<string, unknown>;
  const providerType = a['type'];
  if (typeof providerType !== 'string' || providerType.length === 0) return null;
  const rendered = obj['rendered'];
  let text: string | null = null;
  if (Array.isArray(rendered)) {
    const joined = rendered
      .map((r) => {
        if (typeof r !== 'object' || r === null) return '';
        const content = (r as Record<string, unknown>)['content'];
        return typeof content === 'string' ? content : '';
      })
      .filter((s) => s.length > 0)
      .join('\n\n');
    if (joined.length > 0) text = unwrapRenderedReminder(joined);
  }
  if ((text === null || text.length === 0) && providerType === 'edited_image_file') {
    // No `rendered` block, and its `content` is the whole image as base64 —
    // the generic key/value dump would put megabytes of it in the disclosure.
    const file = a['displayPath'] ?? a['filename'];
    text =
      typeof file === 'string' && file.length > 0
        ? `${file} changed on disk since the agent last read it.`
        : 'An image changed on disk since the agent last read it.';
  }
  if (text === null || text.length === 0) text = fallbackProviderContextText(a);
  return { providerType, label: providerContextLabel(providerType), text };
}

/**
 * Normalise a persisted user turn so a slash-command / skill invocation replays
 * as the clean text the user typed, never the internal wrapper XML or the
 * command's own output (patch/todo.md — "Don't show skill content in history").
 *
 * Claude Code persists a slash command as a user turn wrapped in
 * `<command-message>` / `<command-name>` / `<command-args>` tags, and any output
 * that command prints as a `<local-command-stdout>` (or `stderr`) turn.
 *
 *  - A command *invocation* → the reconstructed `/<name> <args>` (tags stripped).
 *  - A command *output* turn → `null`, signalling the caller to drop it.
 *  - Anything else (an ordinary message) → returned unchanged.
 */
function sanitizeCommandText(text: string): string | null {
  return sanitizeCommandTextWithContext(text).text;
}

/**
 * `sanitizeCommandText`, plus the notes at the front of the turn (notes.ts —
 * every reader below funnels through this one function, so each note Patch
 * sent is separated out here exactly once).
 *
 * On a special (Manager) thread, and for every other note, the host PREPENDS
 * the note to the user's turn as agent context, and Claude Code persists the
 * augmented prompt. The note is separated from `text` so the user's bubble
 * carries only what they typed — and the surface's content-match reconcile
 * still matches (patch/todo.md — "Messages going through twice … in wrong
 * place") — and returned as `notes`, which the readers above replay as their
 * own `chat.note` entries ahead of the message, so what the model was told
 * stays in the record (spec/04 § Notes to the agent). Only LEADING blocks
 * separate: the same words mid-message are the user's own. A turn can carry
 * several, so every leading block does. Any following voice prefix / command
 * wrapper is handled by the logic below (and the surface's voice-prefix strip).
 */
function sanitizeCommandTextWithContext(text: string): {
  text: string | null;
  notes: NoteItem[];
} {
  const { cleaned, items } = extractLeadingNotes(text);
  // Only a message that BEGINS with a wrapper is one: a user who writes the
  // tag in the middle of a sentence ("why does <local-command-stdout> show…")
  // is typing, and must keep their message.
  const isWrapper = /^\s*<(?:command-(?:message|name)|local-command-)/.test(cleaned);
  const nameMatch = isWrapper
    ? /<command-name>\s*\/?([^<]*?)\s*<\/command-name>/.exec(cleaned)
    : null;
  if (nameMatch) {
    const name = nameMatch[1]?.trim() ?? '';
    // A wrapper with no recoverable command name carries nothing useful — drop.
    if (name.length === 0) return { text: null, notes: items };
    const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/.exec(cleaned);
    const args = argsMatch ? (argsMatch[1] ?? '').trim() : '';
    return {
      text: args.length > 0 ? `/${name} ${args}` : `/${name}`,
      notes: items,
    };
  }
  // Command output (stdout/stderr) with no invocation is purely skill-generated
  // internal content — drop it from the replayed transcript.
  if (isWrapper && /<local-command-std(out|err)>/.test(cleaned)) {
    return { text: null, notes: items };
  }
  return { text: cleaned, notes: items };
}
