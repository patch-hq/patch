// The first-run guide: the few things worth trying, and where each lives.
// One list feeds the new-chat intro and the "Getting started" modal, so the two
// never disagree.

export interface GuideItem {
  id: string;
  title: string;
  line: string;
  /** Where the feature lives; absent when it is something you do in the composer. */
  to?: string;
  action?: string;
  /** Shown instead of title/line/action once the step is done. */
  done?: { title: string; line: string };
}

/** What the user has already done, from live state. */
export interface GuideProgress {
  connected: boolean;
  hasChat: boolean;
}

export function isGuideItemDone(id: string, progress: GuideProgress): boolean {
  if (id === 'connect') return progress.connected;
  if (id === 'chat') return progress.hasChat;
  return false;
}

export const GUIDE_PURPOSE = 'Patch runs your coding agents, on this machine or any other.';

export const GUIDE_ITEMS: readonly GuideItem[] = [
  {
    id: 'connect',
    title: 'Connect an AI',
    line: 'Sign in to Claude or ChatGPT. Nothing can be sent until you do.',
    to: '/connect',
    action: 'Sign in',
    done: { title: 'AI connected', line: 'You can send messages. Add another account any time.' },
  },
  {
    id: 'chat',
    title: 'Start a chat in a folder',
    line: 'Pick a folder under New chat and send a message.',
    to: '/chats/new',
    action: 'New chat',
    done: { title: 'First reply received', line: 'Your agent answered your first message.' },
  },
  {
    id: 'model',
    title: 'Switch model or provider',
    line: 'Use the model control in the composer, per chat.',
  },
  {
    id: 'snooze',
    title: 'Snooze and queue',
    line: 'Snooze a chat until it needs you; queue messages while the agent works.',
  },
  {
    id: 'manager',
    title: 'The Manager',
    line: 'A pinned chat for questions about all your chats: what is running, and what needs you.',
  },
  {
    id: 'jobs',
    title: 'Jobs',
    line: 'Run a prompt at set times or when a webhook fires.',
    to: '/jobs',
    action: 'Open Jobs',
  },
  {
    id: 'pads',
    title: 'Pads',
    line: 'Design screens you can edit and send back to a chat.',
    to: '/pads',
    action: 'Open Pads',
  },
  {
    id: 'devices',
    title: 'Add your phone',
    line: 'Link a phone to follow chats and get notified.',
    to: '/settings/devices',
    action: 'Open Devices',
  },
  {
    id: 'hosts',
    title: 'Add another machine',
    line: 'Run chats on a second computer or server.',
    to: '/settings/hosts',
    action: 'Open Hosts',
  },
];
