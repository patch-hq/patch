// Settings → Chats holds the project order that used to hide under the sort
// menu's "Advanced" fold (spec/14 § Sidebar ordering).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatsPage } from '../routes/settings/ChatsPage.js';
import { useUiStore } from '../stores/uiStore.js';

describe('Settings → Chats → Order projects by', () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ chatSort: 'last-action', groupSort: 'same-as-chats' });
  });
  afterEach(() => cleanup());

  it('defaults to following the chats and persists a change', () => {
    render(
      <MemoryRouter>
        <ChatsPage />
      </MemoryRouter>,
    );
    const select = screen.getByTestId('group-sort-select') as HTMLSelectElement;
    expect(select.value).toBe('same-as-chats');
    fireEvent.change(select, { target: { value: 'name' } });
    expect(useUiStore.getState().groupSort).toBe('name');
    expect(localStorage.getItem('patch.sidebar.groupSort')).toBe('name');
  });
});
