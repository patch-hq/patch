// The Meeting button's permission popover (design/meeting-mode-v3 Setup screens).
import {
  useMeetingSetup,
  allowMeetingPermission,
  closeMeetingSetup,
  dismissFirstRunSetup,
  startWithoutNames,
  isAllGranted,
} from '../lib/meetingSetup.js';
import { startMeeting } from '../lib/meetingControl.js';
import type { MeetingPermissionKind } from '../lib/desktopBridge.js';

const ROWS: Array<{ kind: MeetingPermissionKind; name: string; hint: string; warn: string }> = [
  { kind: 'microphone', name: 'Microphone', hint: 'Your side of the call', warn: '' },
  { kind: 'callAudio', name: 'Call audio', hint: 'The other side of the call', warn: '' },
  {
    kind: 'accessibility',
    name: 'Accessibility',
    hint: 'Speaker names from Teams, Zoom and Meet',
    warn: 'Without it, speakers show as Unknown',
  },
];

export function MeetingSetup({ chatId }: { chatId: string }): JSX.Element | null {
  const { mode, chatId: target, perms } = useMeetingSetup();
  if (!mode || !perms) return null;
  if (mode === 'start' && target !== chatId) return null;
  const first = mode === 'first-run';
  const close = first ? dismissFirstRunSetup : closeMeetingSetup;
  const callReady = perms.microphone && perms.callAudio;
  return (
    <div className="mm-setup" data-testid="meeting-setup" data-mode={mode} role="dialog">
      <div className="mm-setup-head">
        <b>{first ? 'Meetings' : 'Start meeting'}</b>
        {first ? (
          <button
            type="button"
            className="mm-setup-x"
            title="Not now"
            aria-label="Not now"
            data-testid="meeting-setup-dismiss"
            onClick={close}
          >
            ✕
          </button>
        ) : null}
      </div>
      {ROWS.map((r) => {
        const granted = perms[r.kind];
        return (
          <div className="mm-setup-row" key={r.kind} data-testid={`meeting-perm-${r.kind}`}>
            <span className="mm-setup-name">
              {r.name}
              {first && !granted ? <small>{r.hint}</small> : null}
              {!first && !granted ? (
                <small className="warn">{r.kind === 'accessibility' ? r.warn : r.hint}</small>
              ) : null}
            </span>
            {granted ? (
              <span className="mm-setup-ok">✓ Allowed</span>
            ) : (
              <button
                type="button"
                className="mm-setup-btn pri"
                data-testid={`meeting-allow-${r.kind}`}
                onClick={() => void allowMeetingPermission(r.kind)}
              >
                Allow
              </button>
            )}
          </div>
        );
      })}
      {first ? null : (
        <div className="mm-setup-acts">
          <button
            type="button"
            className="mm-setup-btn"
            data-testid="meeting-start-without-names"
            disabled={!callReady}
            onClick={() => startWithoutNames(chatId)}
          >
            Start without names
          </button>
          <button
            type="button"
            className="mm-setup-btn pri"
            data-testid="meeting-start"
            disabled={!isAllGranted(perms)}
            onClick={() => {
              closeMeetingSetup();
              void startMeeting(chatId);
            }}
          >
            Start
          </button>
        </div>
      )}
    </div>
  );
}
