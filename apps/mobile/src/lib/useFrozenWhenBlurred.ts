import React from 'react';
import { useFocusEffect } from 'expo-router';

/**
 * `value` while this screen is focused; the last focused value while it is
 * not. A stack screen stays mounted underneath the one pushed over it, so
 * without this the Chats list re-sorts every chat on each streamed event while
 * a chat is open, and the JS thread is busy drawing a screen nobody sees.
 */
export function useFrozenWhenBlurred<T>(value: T): T {
  const [focused, setFocused] = React.useState(false);
  useFocusEffect(
    React.useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const held = React.useRef(value);
  if (focused) held.current = value;
  return focused ? value : held.current;
}
