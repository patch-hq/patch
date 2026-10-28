// The chat whose header the enclosing group card draws itself (spec/14 §
// Groups), so that chat's tab does not draw a second one. Null outside a group —
// the detached tab window, a standalone route — where the chat draws its own.
import { createContext, useContext } from 'react';

export const GroupHeaderContext = createContext<string | null>(null);

export function useGroupDrawsHeaderFor(chatId: string): boolean {
  return useContext(GroupHeaderContext) === chatId;
}
