// MeetingDetectionBanner — the shell's call detection has stopped working and
// could not restart itself. Standing, not dismissible: while it shows, no
// "Meeting started" prompt and no auto-end will happen. Clears itself the
// moment detection recovers. Renders nothing in a browser.

import { useEffect, useState, type JSX } from 'react';
import { getDesktopBridge } from '../lib/desktopBridge.js';

export function MeetingDetectionBanner(): JSX.Element | null {
  const [state, setState] = useState<{ off: boolean; message: string | null } | null>(null);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.getMeetingDetection) return;
    let live = true;
    void bridge.getMeetingDetection().then((s) => {
      if (live) setState(s);
    });
    const off = bridge.onMeetingDetection?.((s) => setState(s));
    return () => {
      live = false;
      off?.();
    };
  }, []);

  if (!state?.off) return null;
  return (
    <div className="meeting-detection-banner" data-testid="meeting-detection-banner" role="status">
      <span className="dot" aria-hidden />
      <span>
        Meeting detection is off, so calls won&rsquo;t start or end on their own
        {state.message ? ` (${state.message})` : ''}. Patch is retrying.
      </span>
    </div>
  );
}
