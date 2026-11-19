// A chat made on Patch's retired local-model loop (spec/02 § Provider
// adapters). Its history stays readable, but it cannot continue: local models
// now run as endpoints inside Codex. The banner says so before anyone types,
// and starts a new chat in the same folder, on the same host, on the model's
// successor.

import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { retiredModelNotice } from '@patch/wire';
import type { ChatRow } from '../stores/types.js';

export function newChatOnModelHref(row: Pick<ChatRow, 'folder' | 'hostId'>, model: string): string {
  const q = new URLSearchParams({ folder: row.folder, model });
  if (row.hostId) q.set('host', row.hostId);
  return `/chats/new?${q.toString()}`;
}

export function RetiredModelBanner({ row }: { row: ChatRow }): JSX.Element | null {
  const navigate = useNavigate();
  const notice = retiredModelNotice(row.model);
  if (!notice) return null;
  return (
    <div className="archived-banner" data-testid="retired-model-banner" role="status">
      <span className="archived-banner-label">{notice.message}</span>
      <button
        type="button"
        className="archived-unarchive-btn"
        data-testid="retired-model-new-chat"
        onClick={() => navigate(newChatOnModelHref(row, notice.replacementModel))}
      >
        New chat with this model
      </button>
    </div>
  );
}
