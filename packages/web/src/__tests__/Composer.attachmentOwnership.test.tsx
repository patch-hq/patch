// spec/14 § Composer — unsent attachments are owned by the draft/chat they were
// attached in. Every new-chat draft mounts the composer with chatId "new", so
// the attachment key must come from the draft, not the placeholder chatId.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportAccount } from './presenceHelpers.js';
import { useComposerAttachmentStore } from '../stores/composerAttachmentStore.js';

function mountDraft(draftId: string) {
  return render(
    <Composer
      key={draftId}
      chatId="new"
      newChatDraftId={draftId}
      resolveChatId={async () => null}
      hostId="d1"
      onSend={() => {}}
    />,
  );
}

function attach(name: string): void {
  const file = new File(['x'], name, { type: 'text/plain' });
  fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [file] } });
}

describe('Composer — attachments are per new-chat draft', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
    useComposerAttachmentStore.getState()._reset();
  });
  afterEach(() => cleanup());

  it('an attachment in one draft does not appear in another new chat', () => {
    const first = mountDraft('d-a');
    attach('a.txt');
    expect(screen.getAllByTestId('composer-attachment')).toHaveLength(1);
    first.unmount();

    mountDraft('d-b');
    expect(screen.queryAllByTestId('composer-attachment')).toHaveLength(0);
  });

  it('returning to the first draft restores its attachment', () => {
    const first = mountDraft('d-a');
    attach('a.txt');
    first.unmount();
    mountDraft('d-b').unmount();
    mountDraft('d-a');
    expect(screen.getAllByTestId('composer-attachment')).toHaveLength(1);
  });
});
