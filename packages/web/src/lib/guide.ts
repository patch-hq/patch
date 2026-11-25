// The first-run guide: the few things worth trying, and where each lives.
// One list feeds the new-chat intro and the "Getting started" modal, so the two
// never disagree.

import { formatReset } from './usage.js';

export interface GuideItem {
  id: string;
  title: string;
  line: string;
  /** Where the feature lives; absent when it is something you do in the composer. */
  to?: string;
  action?: string;
  /** Only listed while Settings → Experimental features is on. */
  experimental?: boolean;
  /** Shown instead of title/line/action once the step is done. */
  done?: { title: string; line: string };
}

/** What the user has already done, from live state. */
export interface GuideProgress {
  connected: boolean;
  /** Set when every connected account is out of usage, with when that ends. */
  limited?: { until: number | null } | null;
  hasChat: boolean;
  /** Signed in, but no online host has Claude Code to run a chat. */
  claudeCodeMissing?: boolean;
}

export function isGuideItemDone(id: string, progress: GuideProgress): boolean {
  // Connected but out of usage is not ready: the step stays open.
  if (id === 'connect')
    return progress.connected && !progress.limited && !progress.claudeCodeMissing;
  if (id === 'chat') return progress.hasChat;
  return false;
}

/** What the connect step says when it is done, honest about a spent account. */
export function connectDoneText(progress: GuideProgress): { title: string; line: string } {
  if (progress.claudeCodeMissing && !progress.limited) {
    return {
      title: 'AI connected, but Claude Code is not ready',
      line: 'Patch is setting up Claude Code on this computer and will keep trying. Check Settings → AI accounts.',
    };
  }
  if (progress.limited) {
    const until =
      progress.limited.until === null ? '' : ` until ${formatReset(progress.limited.until)}`;
    return {
      title: 'AI connected, but out of usage',
      line: `No usage left${until}. Messages wait until then. Add another account or provider to carry on.`,
    };
  }
  return { title: 'AI connected', line: 'You can send messages. Add another account any time.' };
}

/** The title and line an item shows now: the honest limit wording replaces the connect step's. */
export function guideItemText(
  item: GuideItem,
  progress: GuideProgress,
): { title: string; line: string } {
  if (
    item.id === 'connect' &&
    progress.connected &&
    (progress.limited || progress.claudeCodeMissing)
  ) {
    return connectDoneText(progress);
  }
  return item;
}

export const GUIDE_PURPOSE =
  'Patch lets you work with AI assistants from your computer or your phone.';

export const GUIDE_ITEMS: readonly GuideItem[] = [
  {
    id: 'connect',
    title: 'Connect an AI',
    line: 'Sign in to Claude or ChatGPT. Nothing can be sent until you do.',
    to: '/connect',
    action: 'Sign in',
    done: { title: 'AI connected', line: 'You can send messages. Add another account any time.' },
    // `connectDoneText` replaces this when the account is out of usage.
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
    experimental: true,
    title: 'The Manager',
    line: 'A pinned chat for questions about all your chats: what is running, and what needs you.',
  },
  {
    id: 'jobs',
    title: 'Jobs',
    line: 'Run a prompt at set times or when another app sends Patch a request.',
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
