// RemoteCallBanner — "call in progress on <device>" with a Switch here button
// (spec/07 § A call can move between devices). Shown on every surface that is
// not itself on a call while another surface holds one; Switch here asks the
// host to end the call there and opens it on this surface.

import type { JSX } from 'react';
import { Phone } from 'lucide-react';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { endRemoteCall, switchCallHere } from '../lib/voiceController.js';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { stripMarkdown } from '../lib/stripMarkdown.js';

const DEVICE_LABEL: Record<string, string> = {
  mobile: 'your phone',
  web: 'another browser',
  desktop: 'another computer',
};

export function RemoteCallBanner(): JSX.Element | null {
  const own = useVoiceStore((s) => s.call);
  const remote = useVoiceStore((s) => Object.values(s.remoteCalls)[0] ?? null);
  const rawName = useChatStore((s) => (remote ? (s.chats[remote.chatId]?.name ?? null) : null));
  if (own || !remote) return null;
  // The same title the sidebar and header show for this chat.
  const chatName =
    remote.chatId === SPECIAL_THREAD_IDS.manager
      ? 'Manager'
      : stripMarkdown(deriveChatTitle(rawName));
  return (
    <div className="remote-call" data-testid="remote-call" role="status">
      <Phone size={14} aria-hidden />
      <span className="rc-text">
        Call in progress on {DEVICE_LABEL[remote.surfaceKind] ?? 'another device'} · {chatName}
      </span>
      <button
        type="button"
        className="rc-switch"
        data-testid="remote-call-switch"
        onClick={() => void switchCallHere(remote.chatId)}
      >
        Switch here
      </button>
      <button
        type="button"
        className="rc-end"
        data-testid="remote-call-end"
        onClick={() => endRemoteCall(remote.chatId, remote.sessionId)}
      >
        End call
      </button>
    </div>
  );
}
