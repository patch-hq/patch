// HostStrugglingBanner — shown on a chat whose host is online but coping badly
// (low on memory, overloaded, slow to answer). Says why and, when memory is the
// cause, which processes hold it; at the critical level it says new turns wait.
// An unreachable host is HostOfflineBanner's job, not this one's.

import type { JSX } from 'react';
import { describeHostCondition } from '@patch/wire';
import { usePresenceStore } from '../stores/presenceStore.js';

export function HostStrugglingBanner({ hostId }: { hostId: string }): JSX.Element | null {
  const condition = usePresenceStore((s) => s.hosts[hostId]?.condition ?? null);
  const hostName = usePresenceStore((s) =>
    (s.hosts[hostId]?.host?.hostName ?? s.hosts[hostId]?.registeredName ?? hostId).trim(),
  );
  if (condition === null) return null;
  return (
    <div className="daemon-offline-banner" data-testid="host-struggling-banner" role="status">
      <span className="dot" aria-hidden />
      <span>{describeHostCondition(hostName, condition)}</span>
    </div>
  );
}
