// Patch's own voice tools, grouped for Settings → MCP (spec/07 § Voice tools).
//
// A user turns a whole group off for the voice, not single built-in tools. The
// lists are the tools' own names, the same strings the host declares to every
// voice provider; the host drops a group's tools from a call when it is off.
// Tools in no group (look back, switch chat, end call, and the hand-off pair)
// are always on: a call cannot work without them, and hand-off has its own
// setting (Settings → Voice calls).

import type { McpServerConfig, McpServerTools, VoiceToolGroup } from './events.js';

export interface VoiceToolGroupInfo {
  id: VoiceToolGroup;
  label: string;
  description: string;
  tools: readonly string[];
}

export const VOICE_TOOL_GROUPS: readonly VoiceToolGroupInfo[] = [
  {
    id: 'chats',
    label: 'Chats',
    description: "Find a chat, see how it's doing, send it a message",
    tools: ['find_chats', 'chat_status', 'send_to_chat'],
  },
  {
    id: 'timers',
    label: 'Timers',
    description: 'Set, change, cancel and list timers',
    tools: ['set_timer', 'change_timer', 'cancel_timer', 'list_timers'],
  },
  {
    id: 'tasks',
    label: 'Tasks and calendar',
    description: 'Add and tick off tasks, read and add calendar events',
    tools: [
      'add_task',
      'complete_task',
      'remove_task',
      'read_project',
      'calendar_agenda',
      'add_event',
    ],
  },
];

/** The group a built-in voice tool belongs to, or undefined for an always-on tool. */
export function voiceToolGroupOf(tool: string): VoiceToolGroup | undefined {
  return VOICE_TOOL_GROUPS.find((g) => g.tools.includes(tool))?.id;
}

/** Patch's own voice tools that are in no group and so always on: hand-off, look back, end call, switch chat. */
export const VOICE_ALWAYS_ON_TOOLS = [
  'pass_to_agent',
  'check_status',
  'look_back',
  'switch_chat',
  'end_call',
] as const;

/** What Settings says under an MCP server: how many tools it has and how many are off for the voice. */
export function mcpServerSummary(
  server: Pick<McpServerConfig, 'voice' | 'voiceOff'>,
  read: McpServerTools | undefined,
): string {
  if (!server.voice) return 'Voice off';
  if (read === undefined) return 'Reading tools…';
  if ('error' in read) return `Not reachable: ${read.error}`;
  const off = read.tools.filter((t) => server.voiceOff.includes(t.name)).length;
  const n = `${read.tools.length} ${read.tools.length === 1 ? 'tool' : 'tools'}`;
  return off === 0 ? n : `${n} · ${off} turned off for the voice`;
}

/** The server with one tool switched on or off for the voice; only the off names are kept. */
export function withVoiceToolSwitch<T extends Pick<McpServerConfig, 'voiceOff'>>(
  server: T,
  tool: string,
  on: boolean,
): T {
  const rest = server.voiceOff.filter((n) => n !== tool);
  return { ...server, voiceOff: on ? rest : [...rest, tool] };
}

/** How many tools the voice has, given what is on: Patch's own, then every MCP server's not turned off. */
export function voiceToolCount(
  servers: readonly McpServerConfig[],
  groupsOff: readonly VoiceToolGroup[],
  read: Readonly<Record<string, McpServerTools>>,
): number {
  let n = VOICE_ALWAYS_ON_TOOLS.length;
  for (const g of VOICE_TOOL_GROUPS) if (!groupsOff.includes(g.id)) n += g.tools.length;
  for (const s of servers) {
    const r = read[s.name];
    if (!s.voice || r === undefined || 'error' in r) continue;
    n += r.tools.filter((t) => !s.voiceOff.includes(t.name)).length;
  }
  return n;
}

/** The note under the tool list: the total, and that many tools cost speed and accuracy. */
export function voiceToolCountNote(count: number): string {
  return `The voice has ${count} tools. With many it can answer more slowly or pick the wrong one.`;
}
