// Linked chats in the Chats tab (spec/04 § Provider switches, § Moving to
// another host). A thread of linked chats is listed once, as its newest chat;
// an earlier one is reached from the divider in the chat that continues it.
// One whose continuation is gone (deleted, or not known on this phone) keeps
// its own row.

interface Linked {
  chatId: string;
  status: string;
  continuedFrom?: string;
  continuedIn?: string;
}

/** The rows a thread lists: every row except one a known, live chat continues. */
export function withoutContinued<T extends Linked>(rows: readonly T[]): T[] {
  const continuations = new Set(
    rows
      .filter((c) => c.status !== 'deleted' && c.continuedFrom !== undefined)
      .map((c) => c.chatId),
  );
  return rows.filter((c) => c.continuedIn === undefined || !continuations.has(c.continuedIn));
}
