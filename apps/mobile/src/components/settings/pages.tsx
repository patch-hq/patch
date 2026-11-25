// The Settings pages, their groups and their order — the same structure and
// names as web Settings (spec/14 § `/settings` details): Setup, Agents, Voice,
// Advanced, App. Each page has a one-line intro, shown in the list and at the
// top of the page. The Settings tab lists them; each opens as its own screen at
// /settings/<id> (app/settings/[page].tsx).

import React from 'react';
import { AccountPage } from './AccountSections';
import { AgentPage } from './AgentBehaviorSection';
import { UsagePage } from './CreditSourcesSection';
import { DevicesPage } from './DevicesSections';
import { HostsPage, ProvidersPage } from './HostsSection';
import { McpPage } from './McpSection';
import { MemoriesPage } from './MemoriesSection';
import { GoalsPage } from './GoalsSection';
import { ChatsPage } from './ChatsSection';
import { ComputerUsePage } from './ComputerUseSection';
import { HooksPage } from './HooksSection';
import { DictationPage, ManagerPage, MeetingsPage, VoicePage } from './PreferenceSections';
import { NotificationsPage } from './NotificationsSection';
import { UpdatesPage } from './VersionSection';
import { ExperimentalPage } from './ExperimentalSection';
import { AgentIdentityPage } from './AgentIdentitySection';

export type SettingsGroup = 'Setup' | 'Agents' | 'Voice' | 'Advanced' | 'App';

/** The groups, in the order the list shows them. */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  'Setup',
  'Agents',
  'Voice',
  'Advanced',
  'App',
];

export interface SettingsPageEntry {
  id: string;
  title: string;
  group: SettingsGroup;
  /** What the page is for, in one line. */
  intro: string;
  Page: () => React.ReactElement;
}

export const SETTINGS_PAGES: readonly SettingsPageEntry[] = [
  {
    id: 'usage',
    title: 'AI accounts',
    group: 'Setup',
    Page: UsagePage,
    intro: "The Claude and ChatGPT accounts your agents run on, and how much of each you've used.",
  },
  {
    id: 'hosts',
    title: 'Hosts',
    group: 'Setup',
    Page: HostsPage,
    intro: 'The computers that run your chats.',
  },
  {
    id: 'devices',
    title: 'Linked devices',
    group: 'Setup',
    Page: DevicesPage,
    intro: 'The phones, browsers and desktops signed in to this account.',
  },
  {
    id: 'providers',
    title: 'Service keys',
    group: 'Setup',
    Page: ProvidersPage,
    intro:
      'Keys for voice, speech and the other outside services Patch uses. Shared by every host.',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    group: 'Setup',
    Page: NotificationsPage,
    intro: 'When Patch gets your attention, and when it sends to your phone instead.',
  },
  {
    id: 'agent',
    title: 'Agent',
    group: 'Agents',
    Page: AgentPage,
    intro: 'What every new chat starts with, and how agents ask, wait and carry on.',
  },
  {
    id: 'chats',
    title: 'Chats',
    group: 'Agents',
    Page: ChatsPage,
    intro: 'Chat titles and status lines, clean-up, and how chats are ordered.',
  },
  {
    id: 'goals',
    title: 'Goals',
    group: 'Agents',
    Page: GoalsPage,
    intro: "How a chat's goal is judged, and when it stops pushing.",
  },
  {
    id: 'memories',
    title: 'Memories',
    group: 'Agents',
    Page: MemoriesPage,
    intro: 'What Claude Code remembers between chats on each host.',
  },
  {
    id: 'manager',
    title: 'Manager',
    group: 'Agents',
    Page: ManagerPage,
    intro:
      "The chat that keeps an eye on all the others: where it runs, what it's told, and its voice.",
  },
  {
    id: 'voice',
    title: 'Voice calls',
    group: 'Voice',
    Page: VoicePage,
    intro: 'Talking to a chat out loud: the voice engine, how it sounds, and who it recognises.',
  },
  {
    id: 'dictation',
    title: 'Dictation',
    group: 'Voice',
    Page: DictationPage,
    intro: 'Speaking instead of typing in the message box.',
  },
  {
    id: 'meetings',
    title: 'Meetings',
    group: 'Voice',
    Page: MeetingsPage,
    intro: "Live notes, actions and research while you're in a meeting.",
  },
  {
    id: 'mcp',
    title: 'Tools (MCP)',
    group: 'Advanced',
    Page: McpPage,
    intro: "Outside tools a host gives every chat it runs, beside Patch's own.",
  },
  {
    id: 'hooks',
    title: 'Hooks',
    group: 'Advanced',
    Page: HooksPage,
    intro: 'Scripts that run when things happen in a chat.',
  },
  {
    id: 'computer',
    title: 'Computer use',
    group: 'Advanced',
    Page: ComputerUsePage,
    intro: "Whether an agent is driving a host's browser right now, with a button to stop it.",
  },
  {
    id: 'identity',
    title: 'Agent identity',
    group: 'Advanced',
    Page: AgentIdentityPage,
    intro: 'How your agent identifies itself to the websites it visits.',
  },
  {
    id: 'updates',
    title: 'Updates',
    group: 'App',
    Page: UpdatesPage,
    intro: "The version you're on, and how updates arrive.",
  },
  {
    id: 'experimental',
    title: 'Experimental features',
    group: 'App',
    Page: ExperimentalPage,
    intro: "Features that aren't finished yet. Turning this on shows them all.",
  },
  {
    id: 'account',
    title: 'Account',
    group: 'App',
    Page: AccountPage,
    intro: 'This device, your account and the server it talks to.',
  },
];

/** Old addresses that still land somewhere: the Prompts page's prompts now live on their own pages. */
const SETTINGS_PAGE_ALIASES: Readonly<Record<string, string>> = { prompts: 'agent' };

export function settingsPage(id: string): SettingsPageEntry | null {
  const resolved = SETTINGS_PAGE_ALIASES[id] ?? id;
  return SETTINGS_PAGES.find((p) => p.id === resolved) ?? null;
}

/** Pages that only exist while Settings → Experimental features is on. */
export const EXPERIMENTAL_PAGE_IDS: readonly string[] = ['manager', 'voice', 'computer'];

export function visibleSettingsPages(experimental: boolean): readonly SettingsPageEntry[] {
  return SETTINGS_PAGES.filter((p) => experimental || !EXPERIMENTAL_PAGE_IDS.includes(p.id));
}
