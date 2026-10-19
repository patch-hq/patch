// ErrorToasts — surfaces queued errors from the uiStore (mobile mirror of the
// web `ErrorToasts`). NO FALLBACK: every failed REST/WS/upload path pushes to
// `uiStore.pushError`, so without this the failure is invisible and the control
// that triggered it reads as a dead no-op (an attachment upload that 502s just
// blinked the send button and did nothing).
//
// Rendered once at the root layout, above every screen and overlay. Pinned to
// the top so a toast never covers the composer or the bottom controls. Tap to
// dismiss; errors also auto-dismiss so a stale one doesn't sit over the UI
// forever.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlarmClock } from 'lucide-react-native';
import { useUiStore } from '../stores/uiStore';
import { fonts, radii, space, useTheme } from '../lib/theme';

/** How long a toast stays up before it dismisses itself. */
export const TOAST_TTL_MS = 8000;

export function ErrorToasts(): React.ReactElement | null {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const errors = useUiStore((s) => s.errors);
  const dismiss = useUiStore((s) => s.dismissError);

  // Auto-dismiss each toast TTL_MS after it was pushed (or last repeated: the
  // store stamps a fresh `at` on a repeat). One timer per toast, keyed by id and
  // stamp, so a later push never extends an older toast's life.
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  React.useEffect(() => {
    const live = new Set<string>();
    for (const e of errors) {
      const key = `${e.id}:${e.at}`;
      live.add(key);
      if (!timers.current.has(key)) {
        timers.current.set(
          key,
          setTimeout(() => dismiss(e.id), TOAST_TTL_MS),
        );
      }
    }
    for (const [key, t] of timers.current) {
      if (!live.has(key)) {
        clearTimeout(t);
        timers.current.delete(key);
      }
    }
  }, [errors, dismiss]);
  React.useEffect(() => {
    const held = timers.current;
    return () => {
      for (const t of held.values()) clearTimeout(t);
      held.clear();
    };
  }, []);

  if (errors.length === 0) return null;
  return (
    <View
      testID="error-toasts"
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: insets.top,
        padding: space.sm,
        gap: space.xs,
      }}
    >
      {errors.map((e) =>
        e.snooze ? (
          <View
            key={e.id}
            testID={`snooze-toast-${e.id}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              backgroundColor: colors.ink,
              borderRadius: radii.md,
              paddingHorizontal: space.md,
              paddingVertical: space.md,
            }}
          >
            <AlarmClock size={16} color={colors.paperRaised} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.paperRaised, fontFamily: fonts.bodyMedium }}>
                {e.message}
              </Text>
              {e.snooze.subline === null ? null : (
                <Text style={{ color: colors.paperRaised, opacity: 0.75, fontFamily: fonts.body }}>
                  {e.snooze.subline}
                </Text>
              )}
            </View>
            <Pressable
              testID="snooze-toast-undo"
              accessibilityRole="button"
              accessibilityLabel="Undo snooze"
              hitSlop={10}
              onPress={() => {
                e.snooze?.undo();
                dismiss(e.id);
              }}
            >
              <Text
                style={{
                  color: colors.paperRaised,
                  fontFamily: fonts.bodyMedium,
                  textDecorationLine: 'underline',
                }}
              >
                Undo
              </Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            key={e.id}
            testID={`error-toast-${e.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${e.message}. Tap to dismiss.`}
            onPress={() => dismiss(e.id)}
            style={{
              backgroundColor: colors.red,
              borderRadius: radii.sm,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
            }}
          >
            <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyMedium }}>
              {e.message}
            </Text>
          </Pressable>
        ),
      )}
    </View>
  );
}
