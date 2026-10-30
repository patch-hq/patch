// ArtifactPane — a published artifact open as a tab (spec/14 § Artifacts). A
// slim address row (back, forward, reload, the artifact's title and file, open
// in the real browser) over the page in a sandboxed frame. The page reloads
// itself when the agent republishes it.
//
// Back and forward act inside the frame: the page is cross-origin (served
// sandboxed), so the served page's own shim reports whether it can go either
// way and performs the move when asked (`server/src/artifacts.ts`).

import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-react';
import { useChatStore } from '../stores/chatStore.js';
import { onArtifactRefresh } from '../lib/artifactRefresh.js';

export function ArtifactPane({
  chatId,
  artifactId,
  url,
}: {
  chatId: string;
  artifactId: string;
  url: string;
}): JSX.Element {
  const entry = useChatStore((s) =>
    s.timelines[chatId]?.find((e) => e.kind === 'artifact' && e.artifactId === artifactId),
  );
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });
  const absolute = new URL(url, window.location.origin);

  const href = absolute.toString();
  const pathname = absolute.pathname;
  const reload = (): void => {
    const frame = frameRef.current;
    if (frame) frame.src = href;
  };

  useEffect(() => {
    function onMessage(e: MessageEvent): void {
      if (e.source !== frameRef.current?.contentWindow) return;
      const d = e.data as { type?: string; canGoBack?: boolean; canGoForward?: boolean };
      if (d?.type !== 'patch:artifact-nav') return;
      setNav({ canGoBack: d.canGoBack === true, canGoForward: d.canGoForward === true });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(
    () =>
      onArtifactRefresh((republished) => {
        const frame = frameRef.current;
        if (republished === pathname && frame) frame.src = href;
      }),
    [pathname, href],
  );

  const go = (dir: 'back' | 'forward'): void =>
    frameRef.current?.contentWindow?.postMessage({ type: 'patch:artifact-go', dir }, '*');

  return (
    <div className="artifact-pane" data-testid="artifact-pane">
      <div className="artifact-pane-bar" data-testid="artifact-pane-bar">
        <button
          type="button"
          className="artifact-pane-btn"
          aria-label="Back"
          title="Back"
          data-testid="artifact-pane-back"
          disabled={!nav.canGoBack}
          onClick={() => go('back')}
        >
          <ArrowLeft size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="artifact-pane-btn"
          aria-label="Forward"
          title="Forward"
          data-testid="artifact-pane-forward"
          disabled={!nav.canGoForward}
          onClick={() => go('forward')}
        >
          <ArrowRight size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="artifact-pane-btn"
          aria-label="Reload"
          title="Reload"
          data-testid="artifact-pane-reload"
          onClick={reload}
        >
          <RotateCw size={14} aria-hidden />
        </button>
        <div className="artifact-pane-address" data-testid="artifact-pane-address">
          <span className="artifact-pane-title">{entry?.artifactTitle ?? 'Artifact'}</span>
          <span className="artifact-pane-file">{entry?.artifactPath ?? ''}</span>
        </div>
        <button
          type="button"
          className="artifact-pane-btn"
          aria-label="Open in browser"
          title="Open in browser"
          data-testid="artifact-pane-external"
          onClick={() => window.open(href, '_blank', 'noopener')}
        >
          <ExternalLink size={14} aria-hidden />
        </button>
      </div>
      <iframe
        ref={frameRef}
        className="artifact-pane-frame"
        data-testid="artifact-pane-frame"
        src={href}
        title={entry?.artifactTitle ?? 'Artifact'}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  );
}
