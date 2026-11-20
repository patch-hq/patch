import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GettingStarted } from '../components/GettingStarted.js';
import { FirstRunIntro } from '../components/FirstRunIntro.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';

beforeEach(() => {
  useUiStore.setState({ guideOpen: false });
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES, loaded: true });
});

describe('first-run intro', () => {
  it('shows until dismissed, and dismissing writes the account preference', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    usePreferencesStore.setState({ update });
    render(<FirstRunIntro />);
    expect(screen.getByTestId('first-run-intro')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('first-run-dismiss'));
    expect(update).toHaveBeenCalledWith({ introDismissed: true });
  });

  it('is hidden once dismissed and before preferences load', () => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, introDismissed: true },
    });
    const { unmount } = render(<FirstRunIntro />);
    expect(screen.queryByTestId('first-run-intro')).toBeNull();
    unmount();
    usePreferencesStore.setState({
      preferences: DEFAULT_PREFERENCES,
      loaded: false,
    });
    render(<FirstRunIntro />);
    expect(screen.queryByTestId('first-run-intro')).toBeNull();
  });

  it('says so when the save fails', async () => {
    usePreferencesStore.setState({ update: vi.fn().mockRejectedValue(new Error('nope')) });
    render(<FirstRunIntro />);
    fireEvent.click(screen.getByTestId('first-run-dismiss'));
    await waitFor(() => expect(screen.getByTestId('first-run-error')).toHaveTextContent('nope'));
  });

  it('the link opens the guide', () => {
    render(<FirstRunIntro />);
    fireEvent.click(screen.getByTestId('first-run-more'));
    expect(useUiStore.getState().guideOpen).toBe(true);
  });
});

describe('progress', () => {
  it('ticks off a connected AI and drops the sign-in prompt', () => {
    usePreferencesStore.setState({
      shared: { secrets: { claude: [{ connected: true }], codex: [] } },
    } as never);
    useUiStore.setState({ guideOpen: true });
    render(
      <MemoryRouter>
        <GettingStarted />
        <FirstRunIntro />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('guide-connect')).toHaveAttribute('data-done', 'true');
    expect(screen.getByTestId('guide-connect')).not.toHaveTextContent('Nothing can be sent');
    expect(screen.queryByTestId('guide-go-connect')).toBeNull();
    expect(screen.getByTestId('first-run-intro')).toHaveTextContent('✓ AI connected');
  });
});

describe('getting started guide', () => {
  it('lists the features and closes', () => {
    useUiStore.setState({ guideOpen: true });
    render(
      <MemoryRouter>
        <GettingStarted />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('guide-jobs')).toBeInTheDocument();
    // Connecting an AI comes first.
    expect(document.querySelector('.guide-item')?.getAttribute('data-testid')).toBe(
      'guide-connect',
    );
    expect(screen.getByTestId('guide-go-pads')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().guideOpen).toBe(false);
  });
});
