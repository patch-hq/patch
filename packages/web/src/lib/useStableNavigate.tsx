import { createContext, useCallback, useContext, useRef, type JSX, type ReactNode } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router-dom';

/**
 * A `navigate` whose identity never changes, for components drawn many times.
 *
 * `useNavigate` subscribes its caller to router context, so a component that
 * calls it re-renders on every navigation — memoised or not. For the sidebar's
 * one-row-per-chat list that is every row at once, which made the folder "+"
 * (new chat) take seconds on a long list. The provider calls `useNavigate`
 * ONCE and hands rows a fixed wrapper over the latest router function; rows
 * read it with `useStableNavigate`, which does not touch router context.
 */
const StableNavigateContext = createContext<NavigateFunction | null>(null);

export function StableNavigateProvider({ children }: { children: ReactNode }): JSX.Element {
  const navigate = useNavigate();
  const ref = useRef(navigate);
  ref.current = navigate;
  const stable = useCallback(
    ((...args: Parameters<NavigateFunction>) =>
      (ref.current as (...a: Parameters<NavigateFunction>) => void)(...args)) as NavigateFunction,
    [],
  );
  return <StableNavigateContext.Provider value={stable}>{children}</StableNavigateContext.Provider>;
}

export function useStableNavigate(): NavigateFunction {
  const nav = useContext(StableNavigateContext);
  if (!nav) throw new Error('useStableNavigate needs a <StableNavigateProvider> above it');
  return nav;
}
