// The meeting permissions popover on the Meeting button (lib/meetingSetup.ts):
// once as a gentle introduction, and again when Meeting is pressed with
// something still missing.

import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { MeetingPermissionKind } from '../lib/desktopBridge.js';
import {
  allowPermission,
  missing,
  readPermissions,
  startFromSetup,
  useMeetingSetup,
} from '../lib/meetingSetup.js';

const ROWS: Array<{ kind: MeetingPermissionKind; name: string; what: string }> = [
  { kind: 'microphone', name: 'Microphone', what: 'Your side of the call' },
  { kind: 'callAudio', name: 'Call audio', what: 'The other side of the call' },
  { kind: 'accessibility', name: 'Accessibility', what: 'Speaker names from Teams, Zoom and Meet' },
];

export function MeetingSetupPopover({ chatId }: { chatId: string }) {
  const open = useMeetingSetup((s) => s.open);
  const permissions = useMeetingSetup((s) => s.permissions);
  const asking = useMeetingSetup((s) => s.asking);
  const close = useMeetingSetup((s) => s.close);
  const shown = open !== null && open.chatId === chatId && permissions !== null;

  // Accessibility is switched on in System Settings: check again on coming back.
  useEffect(() => {
    if (!shown) return;
    const again = () => void readPermissions();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [shown]);

  if (!shown) return null;
  const starting = open.mode === 'start';
  const gaps = missing(permissions);
  const canStart = permissions.microphone === 'granted' && permissions.callAudio === 'granted';
  const onlyNames = gaps.length === 1 && gaps[0] === 'accessibility';

  return (
    <div
      className="mm-setup"
      role="dialog"
      aria-label={starting ? 'Start meeting' : 'Meetings'}
      data-testid="meeting-setup"
      data-mode={open.mode}
    >
      <div className="mm-setup-head">
        <b>{starting ? 'Start meeting' : 'Meetings'}</b>
        <button
          type="button"
          className="mm-setup-x"
          data-testid="meeting-setup-close"
          aria-label={starting ? 'Cancel' : 'Not now'}
          title={starting ? 'Cancel' : 'Not now'}
          onClick={close}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {ROWS.map((r) => {
        const state = permissions[r.kind];
        return (
          <div
            key={r.kind}
            className="mm-perm"
            data-testid={`meeting-perm-${r.kind}`}
            data-state={state}
          >
            <span className="n">
              {r.name}
              {starting && r.kind === 'accessibility' && state !== 'granted' ? (
                <small className="warn">Without it, speakers show as Unknown</small>
              ) : (
                <small>{r.what}</small>
              )}
            </span>
            {state === 'granted' ? (
              <span className="ok">✓ Allowed</span>
            ) : (
              <button
                type="button"
                className={starting && r.kind === 'accessibility' ? 'mm-btn' : 'mm-btn pri'}
                data-testid={`meeting-perm-allow-${r.kind}`}
                disabled={asking !== null}
                onClick={() => void allowPermission(r.kind)}
              >
                {asking === r.kind ? 'Asking…' : 'Allow'}
              </button>
            )}
          </div>
        );
      })}
      {starting ? (
        <div className="mm-setup-acts">
          {onlyNames ? (
            <button
              type="button"
              className="mm-btn"
              data-testid="meeting-start-without-names"
              onClick={() => void startFromSetup(chatId, false)}
            >
              Start without names
            </button>
          ) : null}
          <button
            type="button"
            className="mm-btn pri"
            data-testid="meeting-setup-start"
            disabled={!canStart || gaps.length > 0}
            onClick={() => void startFromSetup(chatId, true)}
          >
            Start
          </button>
        </div>
      ) : null}
    </div>
  );
}
