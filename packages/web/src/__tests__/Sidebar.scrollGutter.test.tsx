// The sidebar reserves the scrollbar gutter only while a scrolling band really
// overflows (`.sb-scrolling`), instead of always leaving an empty strip.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSidebar(): void {
  render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar scrollbar gutter', () => {
  it('reserves no gutter when nothing overflows', () => {
    renderSidebar();
    expect(screen.getByTestId('sidebar').className).not.toContain('sb-scrolling');
  });

  it('reserves the gutter when the chat-list band overflows', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    renderSidebar();
    expect(screen.getByTestId('sidebar').className).toContain('sb-scrolling');
  });
});
