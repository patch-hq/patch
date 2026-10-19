// spec/14 § Message links — clicking the Summarise button fetches and renders
// a summary of the linked page inline; a failed fetch surfaces an error rather
// than silently showing nothing.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LinkPreviewToggle } from '../components/LinkPreview.js';
import { api } from '../api/rest.js';
import { ApiError } from '../api/rest.js';

vi.mock('../api/rest.js', async () => {
  const actual = await vi.importActual<typeof import('../api/rest.js')>('../api/rest.js');
  return { ...actual, api: { linkSummary: vi.fn() } };
});

function renderToggle(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LinkPreviewToggle url={url} />
    </QueryClientProvider>,
  );
}

let createObjectURLSpy: ReturnType<typeof vi.fn>;
let revokeObjectURLSpy: ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LinkPreviewToggle (Summarise)', () => {
  it('is collapsed by default — nothing is fetched until clicked', () => {
    renderToggle('https://example.com/');
    expect(api.linkSummary).not.toHaveBeenCalled();
    expect(screen.queryByTestId('link-summary-card')).toBeNull();
  });

  it('fetches and renders the summary on click', async () => {
    vi.mocked(api.linkSummary).mockResolvedValue({
      url: 'https://example.com/article',
      summary: 'A short summary.',
    });
    renderToggle('https://example.com/article');
    fireEvent.click(screen.getByRole('button', { name: /summarise link/i }));
    expect(api.linkSummary).toHaveBeenCalledWith('https://example.com/article');
    expect(screen.getByText('Summarising…')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('link-summary-text').textContent).toBe('A short summary.'),
    );
    expect(screen.getByText('example.com')).toBeTruthy();
  });

  it('clicking again collapses the card', async () => {
    vi.mocked(api.linkSummary).mockResolvedValue({ url: 'https://example.com/', summary: 'S' });
    renderToggle('https://example.com/');
    fireEvent.click(screen.getByRole('button', { name: /summarise link/i }));
    await waitFor(() => expect(screen.getByTestId('link-summary-text')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /hide link summary/i }));
    expect(screen.queryByTestId('link-summary-card')).toBeNull();
  });

  it('shows the error rather than a silent empty card when the summary fails', async () => {
    vi.mocked(api.linkSummary).mockRejectedValue(new ApiError(502, 'summary_failed', null));
    renderToggle('https://example.com/broken');
    fireEvent.click(screen.getByRole('button', { name: /summarise link/i }));
    await waitFor(() =>
      expect(screen.getByTestId('link-summary-error').textContent).toBe('summary_failed'),
    );
  });

  it('renders no button for a non-http link', () => {
    renderToggle('mailto:a@b.c');
    expect(screen.queryByTestId('link-summary-toggle')).toBeNull();
  });

  it('renders an "open in browser" link pointed at the real URL', () => {
    renderToggle('https://example.com/article');
    const link = screen.getByTestId('link-preview-external') as HTMLAnchorElement;
    expect(link.href).toBe('https://example.com/article');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
  });

  // Todoist: "patch open in browser is not copying over the query string" —
  // the desktop panel's half was fixed in the shell; this is the message
  // link's own open-in-browser icon.
  it('"open in browser" keeps the query string and fragment', () => {
    renderToggle('https://example.com/app/chats/c1?sidebar=hidden&seq=4#m4');
    const link = screen.getByTestId('link-preview-external') as HTMLAnchorElement;
    expect(link.href).toBe('https://example.com/app/chats/c1?sidebar=hidden&seq=4#m4');
  });
});
