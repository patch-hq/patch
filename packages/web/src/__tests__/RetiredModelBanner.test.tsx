// A chat on Patch's retired local-model loop says it cannot continue and
// offers a new chat in the same folder, on the same host, on the model's
// successor in Codex (spec/02 § Provider adapters).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { RetiredModelBanner } from '../components/RetiredModelBanner.js';
import type { ChatRow } from '../stores/types.js';

afterEach(cleanup);

function Where(): JSX.Element {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

const row = (model: string) =>
  ({ chatId: 'c1', folder: '/work/app', hostId: 'h1', model }) as unknown as ChatRow;

describe('RetiredModelBanner', () => {
  it('says the chat cannot continue and starts a new one on the Codex endpoint', () => {
    render(
      <MemoryRouter initialEntries={['/chats/c1']}>
        <Routes>
          <Route path="/chats/c1" element={<RetiredModelBanner row={row('local/qwen3:8b')} />} />
          <Route path="/chats/new" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('retired-model-banner').textContent).toMatch(/cannot continue/);
    fireEvent.click(screen.getByTestId('retired-model-new-chat'));
    const q = new URLSearchParams(screen.getByTestId('where').textContent!.split('?')[1]);
    expect(q.get('folder')).toBe('/work/app');
    expect(q.get('host')).toBe('h1');
    expect(q.get('model')).toBe('openai/endpoint/local/qwen3:8b');
  });

  it('shows nothing for a chat on a model that still runs', () => {
    for (const m of ['claude-opus-5', 'openai/endpoint/ollama/qwen3:8b']) {
      const { container } = render(
        <MemoryRouter>
          <RetiredModelBanner row={row(m)} />
        </MemoryRouter>,
      );
      expect(container.innerHTML).toBe('');
      cleanup();
    }
  });
});
