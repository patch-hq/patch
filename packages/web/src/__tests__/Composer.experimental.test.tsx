// Dictation and calls are experimental: the mic and call buttons only appear
// while Settings → Experimental features is on.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import { reportAccount } from './presenceHelpers.js';

describe('composer dictation and call buttons', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
  });

  it('are absent while experimental features are off', () => {
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES });
    render(<Composer chatId="c1" hostId="d1" onSend={() => {}} />);
    expect(screen.queryByTestId('voice-note-btn')).toBeNull();
    expect(screen.queryByTestId('call-btn')).toBeNull();
  });

  it('are shown once experimental features are on', () => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, experimentalFeatures: true },
    });
    render(<Composer chatId="c1" hostId="d1" onSend={() => {}} />);
    expect(screen.getByTestId('voice-note-btn')).toBeInTheDocument();
    expect(screen.getByTestId('call-btn')).toBeInTheDocument();
  });
});
