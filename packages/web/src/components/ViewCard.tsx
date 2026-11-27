// ViewCard — a view in a transcript (spec/14 § Views): its title, how many items
// it holds and how many marks are waiting to be sent, and an Open button that
// puts it beside this chat.

import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { api } from '../api/rest.js';
import { openViewBesideChat } from '../lib/openView.js';

export function viewIdOfArtifact(artifactId: string | undefined): string | null {
  return artifactId?.startsWith('view-') ? artifactId.slice('view-'.length) : null;
}

export function ViewCard({
  viewId,
  title,
  chatId,
}: {
  viewId: string;
  title: string;
  chatId: string;
}): JSX.Element {
  const { data: view, error } = useQuery({
    queryKey: ['view', viewId],
    queryFn: () => api.getView(viewId),
    refetchInterval: 10_000,
  });
  return (
    <div className="pads-card" data-testid="view-card">
      <div className="pads-card-body">
        <div className="pads-card-title">
          <ListChecks size={14} aria-hidden />
          <span>{view?.title ?? title}</span>
        </div>
        <div className="pads-card-meta">
          {error ? (
            <span data-testid="view-card-error">View unavailable: {(error as Error).message}</span>
          ) : view ? (
            <>
              {view.data.items.length} {view.data.items.length === 1 ? 'item' : 'items'}
              {view.unsent > 0 ? ` · ${view.unsent} to send` : ''}
            </>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className="pads-open"
        data-testid="view-card-open"
        disabled={Boolean(error)}
        onClick={() => openViewBesideChat(viewId, chatId)}
      >
        Open
      </button>
    </div>
  );
}
