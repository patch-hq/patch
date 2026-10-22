// BrowserOpenView — the agent's browser over the whole screen (spec/15 §
// Browser). The page is laid out at this phone's size and pixel ratio, so the
// site shows its own phone layout, sharp. A tap clicks where it lands, a drag
// scrolls (never both), and the keyboard types into the page. Using the page
// takes it over (the agent pauses until Hand back). The down arrow goes back
// to the chat with the browser still live in its card.
//
// A full-screen Modal, so it owns the window: the status bar and the system
// navigation bar are the platform's, and the footer pads past the bottom inset.

import React, { useEffect, useRef, useState, type ReactElement } from 'react';
import { Image, Modal, PixelRatio, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, ChevronLeft, RotateCw } from 'lucide-react-native';
import { useBrowserHandoffStore } from '../../stores/browserHandoffStore';
import { driveState, siteOf, toViewport, viewedTab } from '../../lib/browserHandoff';
import { KEYS_MAX, KEYS_SENTINEL, keysEvents } from '../../lib/browserKeys';
import { sendInput, useBrowserWatch, type ViewerViewport } from '../../lib/browserView';
import { space, textMin, useTheme } from '../../lib/theme';
import { DriveAction, DriveChip, SiteTile, TOUCH_TARGET } from './parts';
import { SignInCard } from './BrowserLiveCard';

const DRAG_SLOP = 12;

export function BrowserOpenView({ chatId }: { chatId: string }): ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const frame = useBrowserHandoffStore((s) => s.frames[chatId]);
  const status = useBrowserHandoffStore((s) => s.status[chatId]);
  const handoff = useBrowserHandoffStore((s) => s.handoffs[chatId]);
  const form = useBrowserHandoffStore((s) => s.forms[chatId]);
  const setView = useBrowserHandoffStore((s) => s.setView);
  const [usePage, setUsePage] = useState<string | null>(null);
  const tabId = viewedTab(handoff, frame, status);
  const state = driveState(handoff, status, tabId);
  const shown = frame && frame.tabId === tabId ? frame : undefined;
  const modern = (frame?.inputVersion ?? 0) >= 2;
  const canInput = Boolean(tabId) && (modern || Boolean(handoff));
  const site = siteOf(shown?.url ?? status?.tabs.find((t) => t.tabId === tabId)?.url ?? '');

  const [stage, setStage] = useState<{ width: number; height: number } | null>(null);
  const [viewport, setViewport] = useState<ViewerViewport | null>(null);
  useEffect(() => {
    if (!stage) return;
    const next = {
      width: Math.floor(stage.width),
      height: Math.floor(stage.height),
      scale: Math.min(3, Math.max(1, PixelRatio.get())),
    };
    const t = setTimeout(() => setViewport(next), 200);
    return () => clearTimeout(t);
  }, [stage?.width, stage?.height]);
  useBrowserWatch(chatId, true, tabId, viewport);

  const send = (input: Parameters<typeof sendInput>[4]): void => {
    if (!tabId) return;
    sendInput(chatId, tabId, modern, handoff?.handoffId, input);
  };

  // The picture's own box: the page at its shape, as wide as the screen allows.
  const fit =
    shown && stage
      ? (() => {
          const k = Math.min(stage.width / shown.width, stage.height / shown.height);
          return { width: Math.floor(shown.width * k), height: Math.floor(shown.height * k) };
        })()
      : null;

  const keysRef = useRef<{
    focus?: () => void;
    setNativeProps?: (p: { text: string }) => void;
  } | null>(null);
  const keysText = useRef(KEYS_SENTINEL);
  const touch = useRef<{ x: number; y: number; lastX: number; lastY: number } | null>(null);
  // Android delivers a drag's onPress BEFORE its touchEnd, so the press has to
  // know about the drag from the moves, not from the end.
  const dragging = useRef(false);
  const scrollAt = (dx: number, dy: number): void => {
    if (!shown || !fit) return;
    const k = shown.width / fit.width;
    send({
      kind: 'scroll',
      x: Math.round(shown.width / 2),
      y: Math.round(shown.height / 2),
      dx: Math.round(dx * k),
      dy: Math.round(dy * k),
    });
  };

  return (
    <Modal visible animationType="slide" onRequestClose={() => setView(chatId, 'card')}>
      <View
        testID="browser-live"
        style={{ flex: 1, backgroundColor: colors.paperRaised, paddingTop: insets.top }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingHorizontal: space.xs,
            minHeight: 52,
            borderBottomWidth: 1,
            borderBottomColor: colors.lineSoft,
          }}
        >
          <Pressable
            testID="browser-live-minimise"
            accessibilityRole="button"
            accessibilityLabel="Back to the chat"
            onPress={() => setView(chatId, 'card')}
            style={{
              minWidth: TOUCH_TARGET,
              minHeight: TOUCH_TARGET,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <ChevronDown size={22} color={colors.ink2} />
          </Pressable>
          {site ? <SiteTile site={site} /> : null}
          <Text
            testID="browser-handoff-url"
            numberOfLines={1}
            style={{ flex: 1, color: colors.ink, fontSize: 16, fontWeight: '600' }}
          >
            {site || 'Browser'}
          </Text>
          <DriveChip state={state} />
          <View style={{ width: space.xs }} />
        </View>
        <View
          testID="browser-stage"
          onLayout={(e: { nativeEvent: { layout: { width: number; height: number } } }) =>
            setStage(e.nativeEvent.layout)
          }
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'flex-start',
            backgroundColor: colors.bgSoft,
          }}
        >
          {shown && fit ? (
            <Pressable
              testID="browser-handoff-frame"
              accessibilityLabel={shown.title || 'Browser tab'}
              onTouchStart={(e: { nativeEvent: { pageX: number; pageY: number } }) => {
                const { pageX, pageY } = e.nativeEvent;
                touch.current = { x: pageX, y: pageY, lastX: pageX, lastY: pageY };
                dragging.current = false;
              }}
              onTouchMove={(e: { nativeEvent: { pageX: number; pageY: number } }) => {
                const t = touch.current;
                if (!t || !canInput) return;
                const { pageX, pageY } = e.nativeEvent;
                if (!dragging.current && Math.hypot(pageX - t.x, pageY - t.y) <= DRAG_SLOP) return;
                dragging.current = true;
                scrollAt(t.lastX - pageX, t.lastY - pageY);
                t.lastX = pageX;
                t.lastY = pageY;
              }}
              onTouchEnd={() => {
                touch.current = null;
              }}
              onPress={(e: { nativeEvent: { locationX: number; locationY: number } }) => {
                if (dragging.current || !canInput) return;
                keysRef.current?.focus?.();
                send({
                  kind: 'pointer',
                  action: 'click',
                  ...toViewport(
                    { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY },
                    fit,
                    shown,
                  ),
                });
              }}
              style={{ width: fit.width, height: fit.height }}
            >
              <Image
                source={{ uri: `data:image/jpeg;base64,${shown.data}` }}
                resizeMode="contain"
                style={{ width: '100%', height: '100%' }}
              />
            </Pressable>
          ) : (
            <Text
              testID="browser-handoff-empty"
              style={{ margin: space.xl, color: colors.inkFaint, fontSize: textMin }}
            >
              {tabId ? 'Connecting' : 'No browser tab is open for this chat'}
            </Text>
          )}
          {canInput ? (
            <TextInput
              key={`${tabId}:${handoff?.handoffId ?? ''}`}
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
              style={{ position: 'absolute', height: 1, width: 1, opacity: 0 }}
            />
          ) : null}
          {handoff && form && usePage !== form.formId ? (
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: space.md }}>
              <SignInCard
                chatId={chatId}
                form={form}
                handoffId={handoff.handoffId}
                onUsePage={() => setUsePage(form.formId)}
              />
            </View>
          ) : null}
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingHorizontal: space.md,
            paddingTop: space.sm,
            paddingBottom: space.sm + insets.bottom,
            borderTopWidth: 1,
            borderTopColor: colors.lineSoft,
          }}
        >
          <Pressable
            testID="browser-back"
            accessibilityRole="button"
            accessibilityLabel="Back"
            disabled={!modern || !shown?.canGoBack}
            onPress={() => send({ kind: 'nav', action: 'back' })}
            style={{
              minWidth: TOUCH_TARGET,
              minHeight: TOUCH_TARGET,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: modern && shown?.canGoBack ? 1 : 0.35,
            }}
          >
            <ChevronLeft size={22} color={colors.ink2} />
          </Pressable>
          <Pressable
            testID="browser-reload"
            accessibilityRole="button"
            accessibilityLabel="Reload"
            disabled={!modern}
            onPress={() => send({ kind: 'nav', action: 'reload' })}
            style={{
              minWidth: TOUCH_TARGET,
              minHeight: TOUCH_TARGET,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: modern ? 1 : 0.35,
            }}
          >
            <RotateCw size={18} color={colors.ink2} />
          </Pressable>
          <View style={{ flex: 1 }}>
            {state === 'needs' && handoff ? (
              <Text
                testID="browser-handoff-title"
                numberOfLines={2}
                style={{ color: colors.ink3, fontSize: textMin }}
              >
                {handoff.reason}
              </Text>
            ) : null}
          </View>
          <DriveAction
            chatId={chatId}
            tabId={tabId}
            state={state}
            handoffId={handoff?.handoffId}
            canDrive={modern}
          />
        </View>
      </View>
    </Modal>
  );
}
