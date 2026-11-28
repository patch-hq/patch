import React from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

/**
 * `value` while this screen is on show; the last value it had on show while it
 * is not. A screen is not on show while another is pushed over it (a stack
 * screen stays mounted underneath) or while the app is in the background (the
 * focused screen stays mounted and its store keeps streaming). Without this the
 * Chats list re-sorts every chat on each streamed event, and on an account with
 * thousands of chats the JS thread is pegged drawing a screen nobody sees —
 * enough for Android to kill the app for CPU while it sits in the background.
 */
export function useFrozenWhenBlurred<T>(value: T): T {
  const [focused, setFocused] = React.useState(false);
  const [active, setActive] = React.useState(AppState.currentState === 'active');
  useFocusEffect(
    React.useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setActive(next === 'active'));
    return () => sub.remove();
  }, []);
  const onShow = focused && active;
  const held = React.useRef(value);
  if (onShow) held.current = value;
  return onShow ? value : held.current;
}
