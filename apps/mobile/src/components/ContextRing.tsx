// ContextRing — how full the open chat's context window is, as a gauge ring with its
// percentage on the composer's action row (spec/14 § Composer — context ring). Tapping it opens a
// small sheet with the figures and a way to the account's Usage page. Drawn
// only once the host has measured the chat.

import React from 'react';
import { Modal, Pressable, Text } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import Svg, { Circle } from 'react-native-svg';
import { useChatStore } from '../stores/chatStore';
import { summariseContext } from '../lib/contextUsage';
import { radii, space, typography, useTheme } from '../lib/theme';
import { ButtonRow, SettingsButton } from './settings/ui';

const SIZE = 22;
const R = 8;
const C = 2 * Math.PI * R;

export function ContextRing({
  chatId,
  size,
}: {
  chatId: string;
  /** The touch target, matching the action row's other icon buttons. */
  size: number;
}): React.ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const context = useChatStore((s) => s.chats[chatId]?.context ?? null);
  const [open, setOpen] = React.useState(false);
  const ctx = summariseContext(context);
  if (!ctx) return null;
  const stroke =
    ctx.level === 'blocked' ? colors.red : ctx.level === 'warn' ? colors.amber : colors.leaf;
  return (
    <>
      <Pressable
        testID="context-ring"
        accessibilityRole="button"
        accessibilityLabel={`Context ${ctx.percent}`}
        onPress={() => setOpen(true)}
        style={{
          minWidth: size,
          height: size,
          flexDirection: 'row',
          gap: space.xs,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Svg width={SIZE} height={SIZE} viewBox="0 0 22 22">
          <Circle cx={11} cy={11} r={R} fill="none" stroke={colors.divider} strokeWidth={2.5} />
          <Circle
            cx={11}
            cy={11}
            r={R}
            fill="none"
            stroke={stroke}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - ctx.fraction)}
            transform="rotate(-90 11 11)"
          />
        </Svg>
        <Text testID="context-ring-label" style={{ ...typography.secondary, color: colors.ink3 }}>
          {ctx.percent}
        </Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          testID="context-sheet-backdrop"
          onPress={() => setOpen(false)}
          style={{
            flex: 1,
            backgroundColor: colors.shade,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Pressable
            testID="context-sheet"
            onPress={() => {}}
            style={{
              backgroundColor: colors.paperRaised,
              borderRadius: radii.lg,
              padding: space.lg,
              width: '85%',
              maxWidth: 380,
              gap: space.sm,
            }}
          >
            <Text style={{ ...typography.secondary, color: colors.ink2 }}>Context window</Text>
            <Text testID="context-sheet-figures" style={{ ...typography.title, color: colors.ink }}>
              {ctx.percent} · {ctx.tokens}
            </Text>
            <ButtonRow>
              <SettingsButton
                testID="context-sheet-usage"
                label="Usage"
                variant="quiet"
                onPress={() => {
                  setOpen(false);
                  router.push('/settings/usage' as Href);
                }}
              />
              <SettingsButton
                testID="context-sheet-close"
                label="Close"
                variant="ghost"
                onPress={() => setOpen(false)}
              />
            </ButtonRow>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
