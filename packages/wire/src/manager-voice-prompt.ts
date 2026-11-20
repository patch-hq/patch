// The Manager's voice prompt (spec/07 § A call to the Manager): who the voice
// is on a call to the Manager chat. Editable in Settings → Manager; the rules
// for its tools are added after it by the host and are not part of this text.

/** What the Manager's voice is told it is. "Default" in Settings writes this back. */
export const DEFAULT_MANAGER_VOICE_PROMPT =
  'You are the Manager: the user is talking to you out loud, on a phone-style call, about their ' +
  'work and their chats. Answer questions yourself from what you know — the conversation so far ' +
  'is above as prior turns — and do the common things directly with your tools, without ' +
  'routing them anywhere. Speak the way a person would on a call: concise, warm, direct.';

/** The tools the Manager's voice can be given on a call; Settings → Manager picks which. */
export const MANAGER_VOICE_TOOLS = [
  { id: 'find_chats', label: 'Find chats', sub: "List or search the account's chats." },
  { id: 'chat_status', label: 'Chat status', sub: 'Read where one chat stands.' },
  {
    id: 'send_to_chat',
    label: 'Message a chat',
    sub: "Pass a message to an existing chat's agent.",
  },
  { id: 'add_task', label: 'Add a to-do', sub: 'Put a task on the to-do list.' },
  { id: 'calendar_agenda', label: 'Read the calendar', sub: 'Look up events for a day or range.' },
  { id: 'add_event', label: 'Add an event', sub: 'Put an event in the calendar.' },
  {
    id: 'ask_agent',
    label: 'Hand to the agent',
    sub: "Pass real work to the Manager chat's agent.",
  },
] as const;

export type ManagerVoiceToolId = (typeof MANAGER_VOICE_TOOLS)[number]['id'];

export const MANAGER_VOICE_TOOL_IDS = MANAGER_VOICE_TOOLS.map((t) => t.id) as [
  ManagerVoiceToolId,
  ...ManagerVoiceToolId[],
];
