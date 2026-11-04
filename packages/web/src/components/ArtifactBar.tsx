// ArtifactBar — every artifact this chat has published, in the status list
// above the transcript (spec/14 § Artifacts — Artifact bar).
//
// The transcript already carries each artifact as its own card, but finding an
// earlier one again means scrolling back to find it. This row is the standing
// index: plain links, newest first, clicking one opens exactly what clicking
// its card would. Nothing to show when the chat has published nothing.
//
// Drawn through the shared StatusRow. Folded, it shows as many links as fit on
// one line and "+N more" in the meta column; when they do not all fit, that
// link (or the "N published" pill) opens one child row per artifact with its
// publish time.

import { Fragment, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { deriveArtifacts, type ArtifactRow } from '../lib/artifacts.js';
import { openArtifact } from '../lib/openArtifact.js';
import { StatusPill, StatusRow } from './StatusRow.js';

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * How many of the links fit on the row's single line. Every link is laid out
 * (those past the edge are clipped and visibility-hidden) so each can be
 * measured; a container with no width yet has nothing to measure against and
 * reports them all.
 */
function useFitCount(
  count: number,
  deps: unknown,
): [React.RefObject<HTMLSpanElement | null>, number] {
  const ref = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState(count);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const width = el.clientWidth;
      if (width === 0) {
        setFit(count);
        return;
      }
      let n = 0;
      for (const child of Array.from(el.children) as HTMLElement[]) {
        if (child.offsetLeft + child.offsetWidth > width) break;
        n += 1;
      }
      setFit(Math.max(1, n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count, deps]);
  return [ref, fit];
}

export function ArtifactBar({ chatId }: { chatId: string }): JSX.Element | null {
  const timeline = useChatStore((s) => s.timelines[chatId]);
  const artifacts = deriveArtifacts(timeline ?? []);
  const open = useUiStore((s) => s.artifactsOpen);
  const setOpen = useUiStore((s) => s.setArtifactsOpen);
  const titles = artifacts.map((a) => a.title).join('\u0000');
  const [linksRef, fit] = useFitCount(artifacts.length, titles);
  if (artifacts.length === 0) return null;

  const hidden = artifacts.length - fit;
  const overflowing = hidden > 0;
  const grouped = artifacts.length > 1 && (overflowing || open);
  const icon = <LayoutTemplate size={16} aria-hidden />;

  function link(a: ArtifactRow, index?: number): JSX.Element {
    const clipped = index !== undefined && index >= fit;
    return (
      <button
        key={a.artifactId}
        type="button"
        className="artifact-link"
        data-testid="artifact-bar-chip"
        title={a.path}
        tabIndex={clipped ? -1 : undefined}
        style={clipped ? { visibility: 'hidden' } : undefined}
        onClick={() => openArtifact(a.url, chatId)}
      >
        {a.title}
      </button>
    );
  }

  const links = (
    <span className="artifact-links" ref={linksRef}>
      {artifacts.map((a, i) => link(a, i))}
    </span>
  );

  if (!grouped) {
    const only = artifacts.length === 1 ? artifacts[0]! : null;
    return (
      <div data-testid="artifact-bar" role="toolbar">
        <StatusRow icon={icon} label="Artifacts" meta={only ? formatClock(only.at) : null}>
          {links}
        </StatusRow>
      </div>
    );
  }

  const summary = `${artifacts.length} published`;
  return (
    <div data-testid="artifact-bar" data-collapsed={open ? 'false' : 'true'} role="toolbar">
      <StatusRow
        icon={icon}
        label="Artifacts"
        meta={
          open ? null : (
            <button
              type="button"
              className="status-link status-link-underline"
              data-testid="artifact-bar-more"
              onClick={() => setOpen(true)}
            >
              {`+${hidden} more`}
            </button>
          )
        }
      >
        {open ? (
          <StatusPill
            open
            onToggle={() => setOpen(false)}
            testId="artifact-bar-toggle"
            label={`Collapse ${summary}`}
          >
            {summary}
          </StatusPill>
        ) : (
          links
        )}
      </StatusRow>
      {open
        ? artifacts.map((a) => (
            <Fragment key={a.artifactId}>
              <StatusRow nested meta={formatClock(a.at)}>
                <span className="artifact-links">{link(a)}</span>
              </StatusRow>
            </Fragment>
          ))
        : null}
    </div>
  );
}
