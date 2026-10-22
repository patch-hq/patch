// The Manager coordinates other chats; it has no Meeting button.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportAccount } from './presenceHelpers.js';

describe('composer meeting button', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
  });

  it('is shown in an ordinary chat', () => {
    render(<Composer chatId="c1" hostId="d1" onSend={() => {}} />);
    expect(screen.getByTestId('meeting-btn')).toBeInTheDocument();
  });

  it('is absent in the Manager chat', () => {
    render(<Composer chatId={SPECIAL_THREAD_IDS.manager} hostId="d1" onSend={() => {}} />);
    expect(screen.queryByTestId('meeting-btn')).toBeNull();
  });
});
