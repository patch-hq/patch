// The Settings pages, their groups and their order (design/settings-redesign):
// Agents — Usage, Chats, Agent, MCP, Memories, Manager, Goals, Voice, Hooks, Computer use; Setup — Hosts, Providers,
// Devices; System — Updates, Account. The Settings tab lists them; each opens
// as its own screen at /settings/<id> (app/settings/[page].tsx).

import React from 'react';
import { AccountPage } from './AccountSections';
import { AgentPage } from './AgentBehaviorSection';
import { UsagePage } from './CreditSourcesSection';
import { DevicesPage } from './DevicesSections';
import { HostsPage, ProvidersPage } from './HostsSection';
import { McpPage } from './McpSection';
import { MemoriesPage } from './MemoriesSection';
import { GoalsPage } from './GoalsSection';
import { PromptsPage } from './PromptsSection';
import { ChatsPage } from './ChatsSection';
import { ComputerUsePage } from './ComputerUseSection';
import { HooksPage } from './HooksSection';
import { ManagerPage, VoicePage } from './PreferenceSections';
import { UpdatesPage } from './VersionSection';
import { AgentIdentityPage } from './AgentIdentitySection';

export type SettingsGroup = 'Agents' | 'Setup' | 'System';

export interface SettingsPageEntry {
  id: string;
  title: string;
  group: SettingsGroup;
  Page: () => React.ReactElement;
}

export const SETTINGS_PAGES: readonly SettingsPageEntry[] = [
  { id: 'usage', title: 'Usage', group: 'Agents', Page: UsagePage },
  { id: 'chats', title: 'Chats', group: 'Agents', Page: ChatsPage },
  { id: 'agent', title: 'Agent', group: 'Agents', Page: AgentPage },
  { id: 'mcp', title: 'MCP', group: 'Agents', Page: McpPage },
  { id: 'memories', title: 'Memories', group: 'Agents', Page: MemoriesPage },
  { id: 'manager', title: 'Manager', group: 'Agents', Page: ManagerPage },
  { id: 'goals', title: 'Goals', group: 'Agents', Page: GoalsPage },
  { id: 'prompts', title: 'Prompts', group: 'Agents', Page: PromptsPage },
  { id: 'voice', title: 'Voice', group: 'Agents', Page: VoicePage },
  { id: 'hooks', title: 'Hooks', group: 'Agents', Page: HooksPage },
  { id: 'computer', title: 'Computer use', group: 'Agents', Page: ComputerUsePage },
  { id: 'hosts', title: 'Hosts', group: 'Setup', Page: HostsPage },
  { id: 'identity', title: 'Agent identity', group: 'Setup', Page: AgentIdentityPage },
  { id: 'providers', title: 'Providers', group: 'Setup', Page: ProvidersPage },
  { id: 'devices', title: 'Devices', group: 'Setup', Page: DevicesPage },
  { id: 'updates', title: 'Updates', group: 'System', Page: UpdatesPage },
  { id: 'account', title: 'Account', group: 'System', Page: AccountPage },
];

export function settingsPage(id: string): SettingsPageEntry | null {
  return SETTINGS_PAGES.find((p) => p.id === id) ?? null;
}
