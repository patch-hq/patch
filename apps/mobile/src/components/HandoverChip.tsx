// "Continue from …" (spec/05 § Handover — Missed move). The phone came to the
// front without the push that would have moved it, and the socket then said the
// user had moved elsewhere. The phone stays put and offers the move for 5 s:
// tap to go, swipe it away or let it run out to stay.

import React from 'react';
import { Animated, Easing, PanResponder, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useViewPositionStore } from '../stores/viewPositionStore';
import { surfaceName } from '../lib/handover';
import { acceptOffer, dismissOffer } from './ViewPositionSync';
import { fonts, radii, space, textMin, useTheme } from '../lib/theme';

export const OFFER_MS = 5_000;

export function HandoverChip(): React.ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const offer = useViewPositionStore((s) => s.offer);
  const left = React.useRef(new Animated.Value(1)).current;
  const dx = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (!offer) return undefined;
    left.setValue(1);
    dx.setValue(0);
    const run = Animated.timing(left, {
      toValue: 0,
      duration: OFFER_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    run.start();
    const timer = setTimeout(() => dismissOffer('ran out'), OFFER_MS);
    return () => {
      run.stop();
      clearTimeout(timer);
    };
  }, [offer, left, dx]);

  const pan = React.useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: (_e, g) => dx.setValue(g.dx),
        onPanResponderRelease: (_e, g) => {
          if (Math.abs(g.dx) > 80) dismissOffer('swiped away');
          else Animated.spring(dx, { toValue: 0, useNativeDriver: false }).start();
        },
      }),
    [dx],
  );

  if (!offer) return null;
  return (
    <Animated.View
      testID="handover-chip"
      {...pan.panHandlers}
      style={{
        position: 'absolute',
        top: space.sm,
        alignSelf: 'center',
        transform: [{ translateX: dx }],
        opacity: dx.interpolate({ inputRange: [-160, 0, 160], outputRange: [0, 1, 0] }),
        zIndex: 20,
        elevation: 6,
      }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={() => acceptOffer((href) => router.navigate(href))}
        style={{
          borderRadius: radii.pill,
          backgroundColor: colors.paperRaised,
          borderWidth: 1,
          borderColor: colors.leaf,
          overflow: 'hidden',
        }}
      >
        <Text
          style={{
            fontFamily: fonts.bodyMedium,
            fontSize: textMin,
            color: colors.ink,
            paddingHorizontal: space.lg,
            paddingVertical: space.sm,
          }}
        >
          Continue from {surfaceName(offer.surfaceKind)}
        </Text>
        <View style={{ height: 2, backgroundColor: colors.paperRaised }}>
          <Animated.View
            testID="handover-chip-timer"
            style={{
              height: 2,
              backgroundColor: colors.leaf,
              width: left.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            }}
          />
        </View>
      </Pressable>
    </Animated.View>
  );
}
