// Republish notice for artifact tabs (spec/14 § Artifacts). The chat store
// calls `refreshArtifact` when the agent republishes a page; an open artifact
// tab for that same page (same path, signature aside) reloads itself.

type Listener = (pathname: string) => void;

const listeners = new Set<Listener>();

export function onArtifactRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function refreshArtifact(url: string): void {
  const pathname = new URL(url, window.location.origin).pathname;
  for (const l of listeners) l(pathname);
}
