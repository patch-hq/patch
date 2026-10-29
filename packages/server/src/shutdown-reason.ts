// Why this server is about to stop, as told to every surface in the close frame
// (CLOSE_SERVER_RESTARTING). 'updating' only when this process has launched the
// installer for a new release (self-update.ts); any other clean stop is a plain
// restart, and surfaces say exactly that rather than guessing it is an update.

let installing = false;

export function noteInstallingUpdate(on: boolean): void {
  installing = on;
}

export function shutdownReason(): 'updating' | 'restarting' {
  return installing ? 'updating' : 'restarting';
}
