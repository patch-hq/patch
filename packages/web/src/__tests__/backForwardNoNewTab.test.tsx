// Back/Forward through the router never adds a tab (todo: "patch back/forward
// should never open a new tab"). Real MemoryRouter + the real pane routes; only
// PaneArea (the heavy renderer) is stubbed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import type { JSX } from 'react';
import { useLayoutStore, setTabDirty, type LeafPane } from '../stores/layoutStore.js';
import { useUiStore } from '../stores/uiStore.js';

vi.mock('../components/PaneArea.js', () => ({ PaneArea: () => null }));

import { ChatPaneRoute } from '../routes/ChatPaneRoute.js';
import { JobsPaneRoute } from '../routes/JobsPaneRoute.js';

let nav: ReturnType<typeof useNavigate>;
function Grab(): null {
  nav = useNavigate();
  return null;
}
function App(): JSX.Element {
  return (
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Grab />
      <Routes>
        <Route path="/chats/:chatId" element={<ChatPaneRoute ws={null} />} />
        <Route path="/jobs" element={<JobsPaneRoute ws={null} />} />
      </Routes>
    </MemoryRouter>
  );
}
const leaf = (): LeafPane => useLayoutStore.getState().root as LeafPane;

beforeEach(() => {
  useLayoutStore.getState()._reset();
  useUiStore.setState({ errors: [] } as never);
});

describe('Back/Forward never open a new tab', () => {
  it('chat -> jobs -> back -> forward keeps one tab', () => {
    render(<App />);
    expect(leaf().tabs).toHaveLength(1);
    act(() => nav('/jobs'));
    expect(leaf().tabs).toHaveLength(1);
    act(() => nav(-1));
    expect(leaf().tabs).toHaveLength(1);
    expect(leaf().tabs[0]!.descriptor.kind).toBe('chat');
    act(() => nav(1));
    expect(leaf().tabs).toHaveLength(1);
    expect(leaf().tabs[0]!.descriptor.kind).toBe('page');
  });

  it('with unsaved edits Back adds no tab and reports why', () => {
    render(<App />);
    act(() => nav('/jobs'));
    setTabDirty(leaf().tabs[0]!.id, true);
    act(() => nav(-1));
    expect(leaf().tabs).toHaveLength(1);
    expect(leaf().tabs[0]!.descriptor.kind).toBe('page');
    expect(JSON.stringify(useUiStore.getState())).toContain('unsaved changes');
    setTabDirty(leaf().tabs[0]!.id, false);
  });
});
