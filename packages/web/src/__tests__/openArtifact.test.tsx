// spec/14 § Artifacts — an artifact opens as a tab in its chat's group: a tab
// in the chat's pane normally, a pane beside the chat when the group is wider
// than 1,400 px. Already open: focused, not duplicated.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useLayoutStore, firstLeaf } from '../stores/layoutStore.js';
import { openArtifact } from '../lib/openArtifact.js';
import { ArtifactPane } from '../components/ArtifactPane.js';
import { useChatStore } from '../stores/chatStore.js';
import { refreshArtifact } from '../lib/artifactRefresh.js';
import type { WireEvent } from '@patch/wire';

const chatId = 'chat_a';
const url = `/api/chats/${chatId}/artifact/abc?sig=s`;

function setGroupWidth(px: number): void {
  const group = useLayoutStore.getState().groups.find((g) => g.chatId === chatId)!;
  const el = document.createElement('section');
  el.setAttribute('data-testid', `group-${group.id}`);
  el.getBoundingClientRect = () => ({ width: px }) as DOMRect;
  document.body.appendChild(el);
}

describe('openArtifact', () => {
  beforeEach(() => {
    useLayoutStore.getState()._reset?.();
    useLayoutStore.getState().showChat(chatId);
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens a tab in the chat pane in a group of 1,400 px or less', () => {
    setGroupWidth(1400);
    openArtifact(url, chatId);
    const s = useLayoutStore.getState();
    expect(s.root.type).toBe('leaf');
    const leaf = firstLeaf(s.root);
    expect(leaf.tabs.map((t) => t.id)).toEqual([`chat:${chatId}`, `page:artifact:${chatId}:abc`]);
  });

  it('opens a pane beside the chat in a group wider than 1,400 px', () => {
    setGroupWidth(1401);
    openArtifact(url, chatId);
    const root = useLayoutStore.getState().root;
    expect(root.type).toBe('split');
    if (root.type !== 'split') return;
    expect(root.direction).toBe('row');
    expect(root.children).toHaveLength(2);
    const [chatPane, artifactPane] = root.children.map((c) => c.pane);
    expect(chatPane!.type === 'leaf' && chatPane!.tabs[0]!.id).toBe(`chat:${chatId}`);
    expect(artifactPane!.type === 'leaf' && artifactPane!.tabs[0]!.id).toBe(
      `page:artifact:${chatId}:abc`,
    );
  });

  it('focuses an artifact that is already open instead of duplicating it', () => {
    setGroupWidth(1000);
    openArtifact(url, chatId);
    openArtifact(url, chatId);
    const leaf = firstLeaf(useLayoutStore.getState().root);
    expect(leaf.tabs.filter((t) => t.id.startsWith('page:artifact'))).toHaveLength(1);
  });

  it('refuses a URL that is not an artifact', () => {
    expect(() => openArtifact('/somewhere/else', chatId)).toThrow(/Not an artifact URL/);
  });
});

describe('ArtifactPane', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useChatStore.getState().applyEvent({
      type: 'chat.artifact',
      chatId,
      artifactId: 'abc',
      title: 'Bus times',
      url,
      path: 'out/buses.html',
      updatedAt: 1,
      seq: 1,
    } as WireEvent);
  });

  it('shows title and file, and loads the signed artifact URL in a sandboxed frame', () => {
    render(<ArtifactPane chatId={chatId} artifactId="abc" url={url} />);
    expect(screen.getByTestId('artifact-pane-address')).toHaveTextContent('Bus times');
    expect(screen.getByTestId('artifact-pane-address')).toHaveTextContent('out/buses.html');
    const frame = screen.getByTestId('artifact-pane-frame') as HTMLIFrameElement;
    expect(frame.src).toContain(url);
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
  });

  it('opens in the real browser', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<ArtifactPane chatId={chatId} artifactId="abc" url={url} />);
    fireEvent.click(screen.getByTestId('artifact-pane-external'));
    expect(String(open.mock.calls[0]![0])).toContain(url);
    open.mockRestore();
  });

  it('reloads itself when the same artifact is republished, not another', () => {
    render(<ArtifactPane chatId={chatId} artifactId="abc" url={url} />);
    const frame = screen.getByTestId('artifact-pane-frame') as HTMLIFrameElement;
    const set = vi.fn();
    Object.defineProperty(frame, 'src', { configurable: true, get: () => 'x', set });
    act(() => refreshArtifact(`/api/chats/${chatId}/artifact/other?sig=s`));
    expect(set).not.toHaveBeenCalled();
    act(() => refreshArtifact(url));
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('back and forward follow what the page reports, and ask the page to move', () => {
    render(<ArtifactPane chatId={chatId} artifactId="abc" url={url} />);
    const frame = screen.getByTestId('artifact-pane-frame') as HTMLIFrameElement;
    const back = screen.getByTestId('artifact-pane-back');
    expect(back).toBeDisabled();
    const post = vi.fn();
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: { postMessage: post },
    });
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow as Window,
          data: { type: 'patch:artifact-nav', canGoBack: true, canGoForward: false },
        }),
      );
    });
    expect(back).toBeEnabled();
    fireEvent.click(back);
    expect(post).toHaveBeenCalledWith({ type: 'patch:artifact-go', dir: 'back' }, '*');
  });
});
