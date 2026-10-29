// HostStrugglingBar — shown on a chat whose host is online but coping badly (low
// on memory, overloaded, slow to answer). Says why and, when memory is the cause,
// which processes hold it. Mobile twin of web's HostStrugglingBanner. An
// unreachable host is HostOfflineBanner's job, not this one's.

import React, { type ReactElement } from 'react';
import { Text } from 'react-native';
import { describeHostCondition } from '@patch/wire';
import { usePresenceStore } from '../../stores/presenceStore';
import { textMin, useTheme } from '../../lib/theme';
import { BarShell } from './BarShell';

export function HostStrugglingBar({ hostId }: { hostId: string }): ReactElement | null {
  const colors = useTheme();
  const condition = usePresenceStore((s) => s.hosts[hostId]?.condition ?? null);
  const hostName = usePresenceStore((s) => (s.hosts[hostId]?.host?.hostName ?? hostId).trim());
  if (condition === null) return null;
  return (
    <BarShell testID="host-struggling-bar" role="alert">
      <Text style={{ color: colors.ink, fontSize: textMin }}>
        {describeHostCondition(hostName, condition)}
      </Text>
    </BarShell>
  );
}
