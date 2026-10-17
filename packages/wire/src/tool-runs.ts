// spec/14 ## Main chat panel — "Tool runs collapse to one row". Which tool
// calls may fold into a run is decided HERE, once, because three places must
// agree on it: web and mobile draw the runs, and the host summarises each run
// it saw close (`chat.tool_run_summary`, keyed by the run's call ids). A run the
// host cut differently from a surface would name calls that surface never
// grouped, and its summary would have nowhere to go.

/**
 * Can this tool call fold into a run? A file edit keeps its own row for its
 * inline diff, a `Monitor` for the watcher it armed, and a `view_file` because
 * its row IS the file — folded away, the picture only mounts on expand.
 */
export function isGroupableToolCall(tool: string | undefined, args: unknown): boolean {
  if (tool === undefined) return true;
  if (tool === 'Monitor') return false;
  if (tool === 'view_file' || tool === 'mcp__patch__view_file') return false;
  // A notification is a message to the user: it stays in the transcript.
  if (tool === 'patch_notify' || tool === 'mcp__patch__patch_notify') return false;
  // The agent's plan is a checklist card in the transcript, not a command.
  if (tool === 'TodoWrite') return false;
  return !isEditToolCall(tool, args);
}

export interface TodoCardItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * The checklist a `TodoWrite` call carries, for surfaces to draw as a card.
 * Null when the args are not a non-empty list of `{ content, status }` — the
 * call then renders as an ordinary row rather than an empty or guessed card.
 */
export function todoCardItems(args: unknown): TodoCardItem[] | null {
  const todos = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const list = todos['todos'];
  if (!Array.isArray(list) || list.length === 0) return null;
  const items: TodoCardItem[] = [];
  for (const t of list) {
    if (typeof t !== 'object' || t === null) return null;
    const { content, status } = t as Record<string, unknown>;
    if (typeof content !== 'string' || content === '') return null;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null;
    items.push({ text: content, status });
  }
  return items;
}

/** A file-edit call, which renders its own row with an inline diff. */
export function isEditToolCall(tool: string, args: unknown): boolean {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  return (
    /edit|write/i.test(tool) &&
    typeof a['file_path'] === 'string' &&
    (typeof a['old_string'] === 'string' || typeof a['new_string'] === 'string')
  );
}

/** A run's AI label as a surface stores it (`chat.tool_run_summary`). */
export interface ToolRunLabel {
  callIds: string[];
  summary: string | null;
  error?: string;
  live?: boolean;
}

/**
 * The label that applies to the run a surface has drawn, or undefined. A
 * closed label names exactly the run's calls. A LIVE narration was written
 * while the run was still growing, so it names a leading part of it — still
 * the best account of the run until the closed label replaces it. A run this
 * surface cut differently (rule drift) gets no label for other calls.
 */
export function labelForRun(
  label: ToolRunLabel | undefined,
  callIds: ReadonlyArray<string | undefined>,
): ToolRunLabel | undefined {
  if (label === undefined) return undefined;
  const same = (n: number) =>
    label.callIds.length === n && label.callIds.every((id, i) => callIds[i] === id);
  if (same(callIds.length)) return label;
  if (label.live === true && label.callIds.length < callIds.length && same(label.callIds.length))
    return label;
  return undefined;
}
