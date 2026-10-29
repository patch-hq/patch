// A `patch_agent` / `patch_delegate` child finishing in the background. The host
// delivers its reply into the parent as a host turn; this is the one format
// for it, written by the host and read by every surface so the turn renders
// as a quiet system row ("Agent returned: <title>") rather than a user bubble.

export interface AgentReturn {
  /** The child agent's short title. */
  title: string;
  /** The child's chat id — the spawn tool row it belongs to. */
  id: string;
  reply: string;
}

const AGENT_RETURN = /^\[from ([\s\S]*?); agent ([\w-]+)\] ([\s\S]*)$/;

export function formatAgentReturn(title: string, id: string, reply: string): string {
  return `[from ${title}; agent ${id}] ${reply}`;
}

/** `null` when the text is not an agent return — an ordinary message stays one. */
export function parseAgentReturn(content: string): AgentReturn | null {
  const m = AGENT_RETURN.exec(content);
  if (!m) return null;
  return { title: m[1] ?? '', id: m[2] ?? '', reply: (m[3] ?? '').trim() };
}
