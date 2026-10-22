// What a failed turn says to the person reading the chat.
//
// The provider's text stays as the error message every predicate in
// chatRunner matches on; this only decides what the bubble and the job's run
// row show. Two shapes a person could not read: Claude Code's own crash
// report, "[session_crash] error_name=AbortError api_error_status=none
// cause_name=none", and a turn that died because the machine slept under it,
// which is not a failure of the turn at all and is re-sent once the machine
// is properly awake.

export const SLEPT_THROUGH_MESSAGE =
  "Machine went to sleep mid-turn. Runs again once it's been awake a few minutes.";

const SESSION_CRASH = /\[session_crash\]\s*error_name=([A-Za-z_]+)/;

export function describeTurnFailure(errMsg: string, opts: { sleptThrough: boolean }): string {
  if (opts.sleptThrough) return SLEPT_THROUGH_MESSAGE;
  const crash = SESSION_CRASH.exec(errMsg);
  if (crash) return `Claude Code crashed mid-turn (${crash[1]}).`;
  return errMsg;
}
