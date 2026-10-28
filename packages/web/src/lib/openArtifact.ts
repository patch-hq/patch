// openArtifact — show a published artifact page (spec/14 § Artifacts).
//
// An artifact is an ordinary tab in the group of the chat that published it,
// on desktop and web alike. In a group wider than ARTIFACT_BESIDE_MIN_PX a
// newly opened artifact takes a pane beside the chat instead of a tab behind
// it; otherwise it is a tab in the chat's own pane. An artifact already open
// is only focused. The URL is always the server-served artifact URL, never
// something reconstructed locally.

import { useLayoutStore, type TabDescriptor } from '../stores/layoutStore.js';
import { openPadBesideChat } from './openPad.js';

/** A group wider than this opens a new artifact beside the chat, not behind it. */
export const ARTIFACT_BESIDE_MIN_PX = 1400;

const ARTIFACT_PATH = /^\/api\/chats\/([^/]+)\/artifact\/([^/?#]+)$/;

function groupWidth(chatId: string): number {
  const group = useLayoutStore.getState().groups.find((g) => g.chatId === chatId);
  if (!group) return 0;
  const el = document.querySelector(`[data-testid="group-${group.id}"]`);
  return el ? el.getBoundingClientRect().width : 0;
}

export function openArtifact(url: string, chatId: string): void {
  // A Pad card is a `chat.artifact` whose url is the Pad's own route: it opens
  // beside its chat in a pane (spec/14 § Pads).
  const pad = /^\/pads\/([^/?#]+)$/.exec(url);
  if (pad) {
    openPadBesideChat(decodeURIComponent(pad[1] as string), chatId);
    return;
  }
  const absolute = new URL(url, window.location.origin);
  const match = ARTIFACT_PATH.exec(absolute.pathname);
  if (!match) throw new Error(`Not an artifact URL: ${url}`);
  const tab: TabDescriptor = {
    kind: 'page',
    page: 'artifact',
    chatId,
    artifactId: decodeURIComponent(match[2] as string),
    url: absolute.toString(),
  };

  const store = useLayoutStore.getState();
  if (store.findTab(tab)) {
    store.openTab(tab);
    return;
  }
  const chatTab: TabDescriptor = { kind: 'chat', chatId };
  let chat = store.findTab(chatTab);
  if (!chat) {
    store.showChat(chatId);
    chat = useLayoutStore.getState().findTab(chatTab);
  }
  if (!chat) {
    useLayoutStore.getState().openTab(tab);
    return;
  }
  const beside = groupWidth(chatId) > ARTIFACT_BESIDE_MIN_PX;
  useLayoutStore
    .getState()
    .openTab(
      tab,
      beside
        ? { paneId: chat.pane.id, placement: 'split', edge: 'right' }
        : { paneId: chat.pane.id, placement: 'tab' },
    );
}
