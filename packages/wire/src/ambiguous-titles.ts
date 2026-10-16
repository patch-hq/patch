// Which chat titles are ambiguous across hosts (spec/04 § Name). Two chats
// with the same title on different hosts cannot be told apart in a list, so a
// surface shows the host on those rows and only those. The same title twice on
// ONE host is not helped by a host label, so it does not count.

/** The slice of a chat row the rule reads. */
export interface TitledHostChat {
  hostId: string;
  title: string;
}

/** Titles that appear on more than one host. */
export function titlesOnSeveralHosts(chats: Iterable<TitledHostChat>): Set<string> {
  const hostsByTitle = new Map<string, Set<string>>();
  for (const { title, hostId } of chats) {
    const hosts = hostsByTitle.get(title);
    if (hosts) hosts.add(hostId);
    else hostsByTitle.set(title, new Set([hostId]));
  }
  const out = new Set<string>();
  for (const [title, hosts] of hostsByTitle) if (hosts.size > 1) out.add(title);
  return out;
}
