// The sidebar draws one ChatRowView per chat, each memoised. react-router's
// own `useNavigate` returns a NEW function whenever the location changes, so a
// row that calls it re-renders on every navigation — all of them at once, which
// is what made the folder "+" (new chat) take seconds on a long list. The
// stable variant keeps one identity for the life of the component.
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { StableNavigateProvider, useStableNavigate } from '../lib/useStableNavigate';

type Nav = ReturnType<typeof useNavigate>;

function Probe({ stable, seen }: { stable: boolean; seen: Nav[] }): null {
  // Calls ONE of the two, as a real row does — the other would itself
  // subscribe the component to router context.
  seen.push(stable ? useStableNavigate() : useNavigate());
  return null;
}

let go: Nav | null = null;
function Driver(): null {
  go = useNavigate();
  useLocation();
  return null;
}

function run(stable: boolean): { seen: Nav[]; loc: () => string } {
  const seen: Nav[] = [];
  let path = '';
  function Loc(): null {
    path = useLocation().pathname;
    return null;
  }
  render(
    <MemoryRouter initialEntries={['/a']}>
      <Driver />
      <Loc />
      <StableNavigateProvider>
        <Probe stable={stable} seen={seen} />
      </StableNavigateProvider>
    </MemoryRouter>,
  );
  act(() => go!('/b'));
  act(() => go!('/c'));
  return { seen, loc: () => path };
}

describe('useStableNavigate', () => {
  it('does not re-render its caller when the location changes', () => {
    const { seen } = run(true);
    // Rendered once and never again: navigating twice did not touch it.
    expect(seen.length).toBe(1);
  });

  it('control: react-router useNavigate changes identity on navigation', () => {
    const { seen } = run(false);
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it('still navigates when called', () => {
    const { seen, loc } = run(true);
    act(() => seen[0]!('/z'));
    expect(loc()).toBe('/z');
  });
});
