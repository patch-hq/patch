// Failed job runs in the sidebar (spec/08 § Logs): one error item per job whose
// latest run could not be dispatched or whose gate broke. It names the job,
// says why in plain words and what to do, and stays until dismissed or the
// job's next run succeeds.

import { useEffect } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { startJobAlertsPolling, useJobAlertsStore } from '../stores/jobAlertsStore.js';
import { CloseIcon } from './icons.js';

export function JobAlerts(): JSX.Element | null {
  const alerts = useJobAlertsStore((s) => s.alerts);
  const error = useJobAlertsStore((s) => s.error);
  useEffect(() => startJobAlertsPolling(15_000), []);
  if (error) {
    return (
      <div className="job-alert-load-error" role="alert" data-testid="job-alerts-error">
        Job alerts failed to load: {error}
      </div>
    );
  }
  if (!alerts || alerts.length === 0) return null;
  return (
    <div className="job-alerts" data-testid="job-alerts">
      {alerts.map((a) => (
        <div className="job-alert" role="alert" key={a.jobId} data-testid="job-alert">
          <div className="job-alert-body">
            <Link to={`/jobs/${a.jobId}`} className="job-alert-name" data-testid="job-alert-name">
              {a.jobName}
            </Link>
            <div className="job-alert-reason" data-testid="job-alert-reason">
              {a.reason}
            </div>
            <div className="job-alert-fix" data-testid="job-alert-fix">
              {a.fixPath ? <Link to={a.fixPath}>{a.fix}</Link> : a.fix}
            </div>
          </div>
          <button
            type="button"
            className="job-alert-dismiss"
            aria-label={`Dismiss alert for ${a.jobName}`}
            data-testid="job-alert-dismiss"
            onClick={() => void useJobAlertsStore.getState().dismiss(a.jobId)}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
