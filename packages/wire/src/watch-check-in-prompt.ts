// The periodic check-in a background task (patch_watch) sends its owning agent
// unless Settings → Prompts supplies another. Shared so the host (which sends
// it) and the web Settings page (which shows it and offers "Back to default")
// name the same text.

/** Placeholders: {description}, {running}, {lastOutput} and {taskId}. */
export const DEFAULT_WATCH_CHECK_IN_PROMPT =
  'Background task "{description}" has been running for {running}. Last output: {lastOutput}. ' +
  'Is it still working as intended? Check patch_watch_output("{taskId}") and patch_watch_stop it if it is stuck or failing.';
