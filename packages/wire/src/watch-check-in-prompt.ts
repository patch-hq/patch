// The periodic check-in a background task (patch_watch) sends its owning agent
// unless Settings → Prompts supplies another. Shared so the host (which sends
// it) and the web Settings page (which shows it and offers "Back to default")
// name the same text.

/** How often a running background task sends its agent the check-in, unless the task sets its own. */
export const DEFAULT_WATCH_CHECK_IN_MINUTES = 60;

/** Placeholders: {description}, {running}, {lastOutput} and {taskId}. */
export const DEFAULT_WATCH_CHECK_IN_PROMPT =
  'Background task "{description}" has been running for {running}. Last output: {lastOutput}. ' +
  'Is it still working as intended? Check patch_watch_output("{taskId}") and patch_watch_stop it if it is stuck or failing.';
