// The Settings pages, in nav order (design/settings-redesign). Each has its
// own address, /settings/<id>.

export type SettingsPageId =
  | 'usage'
  | 'chats'
  | 'agent'
  | 'mcp'
  | 'memories'
  | 'manager'
  | 'goals'
  | 'dictation'
  | 'meetings'
  | 'voice'
  | 'hooks'
  | 'computer'
  | 'activity'
  | 'hosts'
  | 'identity'
  | 'providers'
  | 'notifications'
  | 'devices'
  | 'shortcuts'
  | 'experimental'
  | 'updates'
  | 'bugs'
  | 'account';

/** Expert pages, folded away in the nav until asked for. */
export const ADVANCED_GROUP = 'Advanced';

export const SETTINGS_PAGES: { id: SettingsPageId; title: string; group: string }[] = [
  { id: 'usage', title: 'AI accounts', group: 'Setup' },
  { id: 'hosts', title: 'Hosts', group: 'Setup' },
  { id: 'devices', title: 'Linked devices', group: 'Setup' },
  { id: 'providers', title: 'Service keys', group: 'Setup' },
  { id: 'notifications', title: 'Notifications', group: 'Setup' },
  { id: 'agent', title: 'Agent', group: 'Agents' },
  { id: 'chats', title: 'Chats', group: 'Agents' },
  { id: 'goals', title: 'Goals', group: 'Agents' },
  { id: 'memories', title: 'Memories', group: 'Agents' },
  { id: 'manager', title: 'Manager', group: 'Agents' },
  { id: 'voice', title: 'Voice calls', group: 'Voice' },
  { id: 'dictation', title: 'Dictation', group: 'Voice' },
  { id: 'meetings', title: 'Meetings', group: 'Voice' },
  { id: 'mcp', title: 'Tools (MCP)', group: ADVANCED_GROUP },
  { id: 'hooks', title: 'Hooks', group: ADVANCED_GROUP },
  { id: 'computer', title: 'Computer use', group: ADVANCED_GROUP },
  { id: 'identity', title: 'Agent identity', group: ADVANCED_GROUP },
  { id: 'activity', title: 'Activity log', group: ADVANCED_GROUP },
  { id: 'shortcuts', title: 'Shortcuts', group: 'App' },
  { id: 'updates', title: 'Updates', group: 'App' },
  { id: 'experimental', title: 'Experimental features', group: 'App' },
  { id: 'bugs', title: 'Bug reports', group: 'App' },
  { id: 'account', title: 'Account', group: 'App' },
];

/** Old addresses that still land somewhere: the Prompts page's prompts now live on their own pages. */
export const SETTINGS_PAGE_ALIASES: Readonly<Record<string, SettingsPageId>> = {
  prompts: 'agent',
};

/** The page `/settings` itself shows beside the nav on a wide screen. */
export const DEFAULT_SETTINGS_PAGE: SettingsPageId = 'usage';

/** Pages that only exist while Settings → Experimental features is on. */
export const EXPERIMENTAL_SETTINGS_PAGES: readonly SettingsPageId[] = ['manager', 'voice'];

export function visibleSettingsPages(experimental: boolean): typeof SETTINGS_PAGES {
  return SETTINGS_PAGES.filter((p) => experimental || !EXPERIMENTAL_SETTINGS_PAGES.includes(p.id));
}
