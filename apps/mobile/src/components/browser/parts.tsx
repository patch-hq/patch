// Small pieces every view of the agent's browser on the phone shares (spec/15
// § Browser): a site's mark, who has the tab, and the one action that changes
// it. Mirrors packages/web/src/components/BrowserView.tsx's.

import React, { type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Check, Hand, Play } from 'lucide-react-native';
import { fixed, radii, space, textMin, useTheme } from '../../lib/theme';
import type { DriveState } from '../../lib/browserHandoff';
import { sendDone, sendDrive } from '../../lib/browserView';

export const TOUCH_TARGET = 44;

/** A site's mark: its first letter on a colour of its own. Nothing is fetched from the site. */
export function SiteTile({ site, size = 22 }: { site: string; size?: number }): ReactElement {
  let hash = 0;
  for (const ch of site) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <View
      testID="browser-site-tile"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        backgroundColor: `hsl(${hash % 360}, 38%, 34%)`,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: fixed.onShade, fontSize: textMin, fontWeight: '700' }}>
        {(site[0] ?? '·').toUpperCase()}
      </Text>
    </View>
  );
}

export function DriveChip({ state }: { state: DriveState }): ReactElement {
  const colors = useTheme();
  const look = {
    agent: { bg: colors.accentTint, fg: colors.leafSoft, label: 'Agent' },
    user: { bg: colors.permissionTint, fg: colors.permission, label: 'You' },
    needs: { bg: colors.waitingTint, fg: colors.waiting, label: 'Needs you' },
  }[state];
  return (
    <View
      testID="browser-drive-chip"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: look.bg,
        borderRadius: radii.pill,
        paddingHorizontal: space.sm + 2,
        paddingVertical: 4,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: look.fg }} />
      <Text style={{ color: look.fg, fontSize: textMin, fontWeight: '600' }}>{look.label}</Text>
    </View>
  );
}

/** Take over, Hand back, or Done when the agent asked. Nothing on a host too old to take over. */
export function DriveAction({
  chatId,
  tabId,
  state,
  handoffId,
  canDrive,
  onTakeOver,
}: {
  chatId: string;
  tabId: string | undefined;
  state: DriveState;
  handoffId: string | undefined;
  canDrive: boolean;
  onTakeOver?: () => void;
}): ReactElement | null {
  const colors = useTheme();
  const pill = (dark: boolean) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 6,
    minHeight: TOUCH_TARGET,
    minWidth: TOUCH_TARGET,
    paddingHorizontal: space.lg,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: dark ? colors.ink : colors.divider,
    backgroundColor: dark ? colors.ink : colors.paperRaised,
  });
  const label = (dark: boolean) => ({
    color: dark ? colors.paperRaised : colors.ink,
    fontSize: textMin,
    fontWeight: '600' as const,
  });
  if (state === 'needs' && handoffId) {
    return (
      <Pressable
        testID="browser-handoff-done"
        accessibilityRole="button"
        accessibilityLabel="Done"
        onPress={() => sendDone(chatId, handoffId, 'done')}
        style={pill(true)}
      >
        <Check size={16} color={colors.paperRaised} />
        <Text style={label(true)}>Done</Text>
      </Pressable>
    );
  }
  if (!tabId || !canDrive) return null;
  if (state === 'user') {
    return (
      <Pressable
        testID="browser-hand-back"
        accessibilityRole="button"
        accessibilityLabel="Hand back"
        onPress={() => sendDrive(chatId, tabId, 'agent')}
        style={pill(true)}
      >
        <Play size={14} color={colors.paperRaised} />
        <Text style={label(true)}>Hand back</Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      testID="browser-take-over"
      accessibilityRole="button"
      accessibilityLabel="Take over"
      onPress={() => {
        sendDrive(chatId, tabId, 'user');
        onTakeOver?.();
      }}
      style={pill(false)}
    >
      <Hand size={16} color={colors.ink} />
      <Text style={label(false)}>Take over</Text>
    </Pressable>
  );
}
