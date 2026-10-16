// BrowserHandoffBar — the agent's browser tab, live in the chat (spec/15 §
// Browser hand-off; mirrors packages/web/src/components/BrowserHandoffPanel).
// Read-only by default ("Watch browser"); when the agent asks for control
// (to sign in, pass 2FA, approve an OAuth consent) taps, typing and keys here
// go straight to the tab and the agent is locked out until Done. What is shown
// and typed travels only between the host and this app — it is never a tool
// result, so the model does not see it.
//
// It sits in the chat column above the transcript, never against the bottom of
// the window, so the system navigation bar is already cleared by the composer
// below; it caps its own height so the keyboard it raises still leaves the
// picture and the buttons on screen.

import React, { useEffect, useRef, useState, type ReactElement } from 'react';
import { Image, Pressable, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { ArrowDown, ArrowUp, Check, Eye, Square, X } from 'lucide-react-native';
import type { BrowserHandoffInput } from '@patch/wire';
import { getWs } from '../../api/ws';
import { useBrowserHandoffStore } from '../../stores/browserHandoffStore';
import { useChatStore } from '../../stores/chatStore';
import {
  browsingLabel,
  canStopBrowser,
  chatUsedBrowser,
  toViewport,
} from '../../lib/browserHandoff';
import { radii, space, textMin, useTheme } from '../../lib/theme';

const WATCH_RENEW_MS = 5_000;
const NO_FRAME_MS = 4_000;
const TOUCH_TARGET = 44;
const DRAG_SLOP = 12;
// The hidden keyboard field always holds one invisible character. Android
// sends nothing for Backspace on an empty field, so deleting that character is
// how a Backspace reaches the page.
export const KEYS_SENTINEL = '\u200B';
// The field is uncontrolled (defaultValue, never `value`): a controlled field is
// rewritten to `value` by every re-render — a frame arriving is enough — which
// silently desyncs what we think it holds. It is put back to the sentinel only
// once emptied or grown this long: setNativeProps is asynchronous, and
// resetting after every keystroke raced fast typing ("ab" reached the page as
// "a" then "ab").
const KEYS_MAX = 64;

/**
 * What a change in the hidden field means for the page. `held` is what the
 * native field is believed to contain; it is updated here. Growth is typing,
 * shrinkage is Backspace (one per deleted character, the sentinel included).
 */
export function keysEvents(held: { current: string }, text: string): BrowserHandoffInput[] {
  const before = held.current;
  held.current = text;
  if (text.length < before.length) {
    return Array.from({ length: before.length - text.length }, () => ({
      kind: 'key' as const,
      key: 'Backspace',
    }));
  }
  const typed = (text.startsWith(before) ? text.slice(before.length) : text)
    .split(KEYS_SENTINEL)
    .join('');
  return typed.length > 0 ? [{ kind: 'text', text: typed }] : [];
}

export function BrowserHandoffBar({ chatId }: { chatId: string }): ReactElement | null {
  const colors = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const handoff = useBrowserHandoffStore((s) => s.handoffs[chatId]);
  const frame = useBrowserHandoffStore((s) => s.frames[chatId]);
  const status = useBrowserHandoffStore((s) => s.status[chatId]);
  const timeline = useChatStore((s) => s.timelines[chatId]);
  const [watching, setWatching] = useState(false);
  const [noFrame, setNoFrame] = useState(false);
  const [shown, setShown] = useState<{ width: number; height: number } | null>(null);
  const keysRef = useRef<{
    focus?: () => void;
    setNativeProps?: (props: { text: string }) => void;
  } | null>(null);
  const touchStartY = useRef<number | null>(null);
  const keysText = useRef(KEYS_SENTINEL);
  // True from the moment a touch has travelled past DRAG_SLOP until the next one
  // starts. Android delivers a drag's onPress BEFORE its touchEnd, so the press
  // has to know about the drag from the moves, not from the end.
  const dragging = useRef(false);

  useEffect(() => {
    if (!watching) return;
    const ask = (): void =>
      getWs().safeSend({ type: 'patch.browser_view.watch', chatId, watch: true });
    ask();
    const renew = setInterval(ask, WATCH_RENEW_MS);
    const none = setTimeout(() => setNoFrame(true), NO_FRAME_MS);
    return () => {
      clearInterval(renew);
      clearTimeout(none);
      getWs().safeSend({ type: 'patch.browser_view.watch', chatId, watch: false });
    };
  }, [watching, chatId]);

  // The hidden field remounts holding just the sentinel whenever a hand-off
  // starts, ends or loses its picture; what we believe it holds must follow, or
  // the next keystroke reads as a deletion and reaches the page as Backspaces.
  const handoffId = handoff?.handoffId;
  const hasFrame = Boolean(frame);
  useEffect(() => {
    keysText.current = KEYS_SENTINEL;
  }, [handoffId, hasFrame]);

  useEffect(() => {
    if (frame) setNoFrame(false);
  }, [frame]);

  const chip = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: space.xs,
    backgroundColor: colors.paperRaised,
    borderColor: colors.lineSoft,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    minHeight: TOUCH_TARGET,
    minWidth: TOUCH_TARGET,
    justifyContent: 'center' as const,
  };

  // The user's Stop: ends this chat's browsing (its calls fail with browser_stopped, its tabs close).
  const stop = (): void => getWs().safeSend({ type: 'patch.browser_view.stop', chatId });
  const stoppable = canStopBrowser(status);

  if (!handoff && !watching) {
    if (!chatUsedBrowser(timeline ?? []) && !stoppable) return null;
    return (
      <View
        testID="browser-watch-bar"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.xs,
          paddingHorizontal: space.sm,
          paddingVertical: 2,
        }}
      >
        <Text
          testID="browser-status"
          numberOfLines={1}
          style={{ flex: 1, color: colors.ink2, fontSize: textMin }}
        >
          {browsingLabel(status)}
        </Text>
        <Pressable
          testID="browser-watch"
          accessibilityRole="button"
          accessibilityLabel="Watch browser"
          onPress={() => {
            setNoFrame(false);
            setWatching(true);
          }}
          style={chip}
        >
          <Eye size={14} color={colors.ink2} />
          <Text style={{ color: colors.ink2, fontSize: textMin }}>Watch</Text>
        </Pressable>
        {stoppable ? (
          <Pressable
            testID="browser-stop"
            accessibilityRole="button"
            accessibilityLabel="Stop browsing"
            onPress={stop}
            style={chip}
          >
            <Square size={14} color={colors.ink2} />
            <Text style={{ color: colors.ink2, fontSize: textMin }}>Stop</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const send = (input: BrowserHandoffInput): void => {
    if (!handoff) return;
    getWs().safeSend({
      type: 'patch.browser_handoff.input',
      chatId,
      handoffId: handoff.handoffId,
      input,
    });
  };
  const control = (action: 'done' | 'cancel'): void => {
    if (!handoff) return;
    getWs().safeSend({
      type: 'patch.browser_handoff.control',
      chatId,
      handoffId: handoff.handoffId,
      action,
    });
  };
  const scroll = (dy: number): void => {
    if (!frame) return;
    send({
      kind: 'scroll',
      x: Math.round(frame.width / 2),
      y: Math.round(frame.height / 2),
      dx: 0,
      dy,
    });
  };

  const button = (
    testID: string,
    label: string,
    onPress: () => void,
    icon: ReactElement,
    text?: string,
  ): ReactElement => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={chip}
    >
      {icon}
      {text ? <Text style={{ color: colors.ink2, fontSize: textMin }}>{text}</Text> : null}
    </Pressable>
  );

  return (
    <View
      testID="browser-handoff"
      style={{
        gap: space.xs,
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
        borderBottomWidth: 1,
        borderBottomColor: colors.lineSoft,
        backgroundColor: colors.paper,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
        <Text
          testID="browser-handoff-title"
          numberOfLines={2}
          style={{ flex: 1, color: colors.ink2, fontSize: textMin, fontWeight: '600' }}
        >
          {handoff ? handoff.reason : browsingLabel(status)}
        </Text>
        {handoff ? (
          <>
            {button(
              'browser-handoff-up',
              'Scroll up',
              () => scroll(-400),
              <ArrowUp size={16} color={colors.ink2} />,
            )}
            {button(
              'browser-handoff-down',
              'Scroll down',
              () => scroll(400),
              <ArrowDown size={16} color={colors.ink2} />,
            )}
            {button(
              'browser-handoff-cancel',
              'Cancel',
              () => control('cancel'),
              <X size={16} color={colors.ink2} />,
            )}
            {button(
              'browser-handoff-done',
              'Done',
              () => control('done'),
              <Check size={16} color={colors.leaf} />,
              'Done',
            )}
          </>
        ) : (
          <>
            {stoppable
              ? button(
                  'browser-stop',
                  'Stop browsing',
                  stop,
                  <Square size={16} color={colors.ink2} />,
                  'Stop',
                )
              : null}
            {button(
              'browser-watch-close',
              'Close browser view',
              () => {
                setWatching(false);
                useBrowserHandoffStore.getState().clearFrame(chatId);
              },
              <X size={16} color={colors.ink2} />,
            )}
          </>
        )}
      </View>
      {frame ? (
        <>
          <Pressable
            testID="browser-handoff-frame"
            accessibilityLabel={frame.title || 'Browser tab'}
            onLayout={(e: { nativeEvent: { layout: { width: number; height: number } } }) =>
              setShown(e.nativeEvent.layout)
            }
            onTouchStart={(e: { nativeEvent: { pageY: number } }) => {
              touchStartY.current = e.nativeEvent.pageY;
              dragging.current = false;
            }}
            onTouchMove={(e: { nativeEvent: { pageY: number } }) => {
              const start = touchStartY.current;
              if (start !== null && Math.abs(start - e.nativeEvent.pageY) > DRAG_SLOP) {
                dragging.current = true;
              }
            }}
            onTouchEnd={(e: { nativeEvent: { pageY: number } }) => {
              const start = touchStartY.current;
              touchStartY.current = null;
              if (!handoff || start === null) return;
              const dragged = start - e.nativeEvent.pageY;
              if (Math.abs(dragged) <= DRAG_SLOP) return;
              dragging.current = true;
              scroll(Math.round(dragged * (frame.height / (shown?.height || frame.height))));
            }}
            onPress={(e: { nativeEvent: { locationX: number; locationY: number } }) => {
              if (dragging.current) return;
              keysRef.current?.focus?.();
              if (!handoff || !shown) return;
              send({
                kind: 'pointer',
                action: 'click',
                ...toViewport(
                  { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY },
                  shown,
                  frame,
                ),
              });
            }}
            style={{
              width: '100%',
              aspectRatio: frame.width / frame.height,
              maxHeight: windowHeight * 0.4,
            }}
          >
            <Image
              source={{ uri: `data:image/jpeg;base64,${frame.data}` }}
              resizeMode="contain"
              style={{ width: '100%', height: '100%', borderRadius: radii.sm }}
            />
          </Pressable>
          {handoff ? (
            <TextInput
              key={handoff.handoffId}
              ref={keysRef as never}
              testID="browser-handoff-keys"
              accessibilityLabel="Keyboard"
              defaultValue={KEYS_SENTINEL}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              blurOnSubmit={false}
              onChangeText={(text: string) => {
                for (const event of keysEvents(keysText, text)) send(event);
                if (keysText.current === '' || keysText.current.length > KEYS_MAX) {
                  keysText.current = KEYS_SENTINEL;
                  keysRef.current?.setNativeProps?.({ text: KEYS_SENTINEL });
                }
              }}
              onSubmitEditing={() => send({ kind: 'key', key: 'Enter' })}
              style={{ height: 1, width: 1, opacity: 0 }}
            />
          ) : null}
          <Text
            testID="browser-handoff-url"
            numberOfLines={1}
            style={{ color: colors.ink3, fontSize: textMin }}
          >
            {frame.url}
          </Text>
        </>
      ) : (
        <Text testID="browser-handoff-empty" style={{ color: colors.ink3, fontSize: textMin }}>
          {noFrame ? 'No browser tab is open for this chat' : 'Connecting'}
        </Text>
      )}
    </View>
  );
}
