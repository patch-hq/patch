// Navigation from code that is not a component (a store, a toast's action).
// The shell registers the router's navigate once; nothing else owns routing.

type Navigate = (path: string) => void;
let navigateImpl: Navigate | null = null;

export function setAppNavigate(fn: Navigate | null): void {
  navigateImpl = fn;
}

export function appNavigate(path: string): void {
  if (navigateImpl === null) throw new Error('appNavigate called before the shell mounted');
  navigateImpl(path);
}
