// jobAlertsStore - failed job runs (dispatch-error, broken gate) the sidebar
// shows until dismissed or the job next runs successfully. Polled like the
// Pads list; a failed refresh is kept as `error` and shown, never swallowed
// into "no alerts".

import { create } from 'zustand';
import { api, type JobAlertView } from '../api/rest.js';

interface JobAlertsState {
  /** null until the first refresh lands. */
  alerts: JobAlertView[] | null;
  error: string | null;
  refresh(): Promise<void>;
  dismiss(jobId: string): Promise<void>;
}

export const useJobAlertsStore = create<JobAlertsState>((set, get) => ({
  alerts: null,
  error: null,
  async refresh() {
    try {
      const { alerts } = await api.listJobAlerts();
      set({ alerts, error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
  async dismiss(jobId) {
    try {
      await api.dismissJobAlert(jobId);
      set({ alerts: (get().alerts ?? []).filter((a) => a.jobId !== jobId), error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
}));

/** Keep the store fresh while a component is mounted. */
export function startJobAlertsPolling(intervalMs: number): () => void {
  void useJobAlertsStore.getState().refresh();
  const t = setInterval(() => void useJobAlertsStore.getState().refresh(), intervalMs);
  return () => clearInterval(t);
}
