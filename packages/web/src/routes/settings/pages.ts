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
  | 'prompts'
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

export const SETTINGS_PAGES: { id: SettingsPageId; title: string; group: string }[] = [
  { id: 'usage', title: 'Usage', group: 'Agents' },
  { id: 'chats', title: 'Chats', group: 'Agents' },
  { id: 'agent', title: 'Agent', group: 'Agents' },
  { id: 'mcp', title: 'MCP', group: 'Agents' },
  { id: 'memories', title: 'Memories', group: 'Agents' },
  { id: 'manager', title: 'Manager', group: 'Agents' },
  { id: 'goals', title: 'Goals', group: 'Agents' },
  { id: 'prompts', title: 'Prompts', group: 'Agents' },
  { id: 'voice', title: 'Voice', group: 'Agents' },
  { id: 'hooks', title: 'Hooks', group: 'Agents' },
  { id: 'computer', title: 'Computer use', group: 'Agents' },
  { id: 'activity', title: 'Activity', group: 'Agents' },
  { id: 'hosts', title: 'Hosts', group: 'Setup' },
  { id: 'identity', title: 'Agent identity', group: 'Setup' },
  { id: 'providers', title: 'Providers', group: 'Setup' },
  { id: 'notifications', title: 'Notifications', group: 'Setup' },
  { id: 'devices', title: 'Devices', group: 'Setup' },
  { id: 'shortcuts', title: 'Shortcuts', group: 'Setup' },
  { id: 'experimental', title: 'Experimental features', group: 'System' },
  { id: 'updates', title: 'Updates', group: 'System' },
  { id: 'bugs', title: 'Bug reports', group: 'System' },
  { id: 'account', title: 'Account', group: 'System' },
];

/** The page `/settings` itself shows beside the nav on a wide screen. */
export const DEFAULT_SETTINGS_PAGE: SettingsPageId = 'usage';

/** Pages that only exist while Settings → Experimental features is on. */
export const EXPERIMENTAL_SETTINGS_PAGES: readonly SettingsPageId[] = ['manager'];

export function visibleSettingsPages(experimental: boolean): typeof SETTINGS_PAGES {
  return SETTINGS_PAGES.filter((p) => experimental || !EXPERIMENTAL_SETTINGS_PAGES.includes(p.id));
}
