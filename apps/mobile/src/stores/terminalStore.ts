// Host terminal sessions on the phone (spec/15 § Host files and terminal,
// spec/02 § Terminal sessions — PTY sessions).
//
// One entry per live terminal screen, keyed by the session id the screen
// minted. The store is the session's record — its status, where the shell
// started, and every byte it has printed — so the WebView can be torn down and
// rebuilt (a theme change, a re-mount) and redraw the whole scrollback.
//
// NO FALLBACK. The phone asks for a real PTY; a host too old to know that
// field would strip it and open a pipe shell instead, which in an emulator is
// a screen that echoes nothing and never prompts. So a ready that does not say
// `pty: true` is not accepted: the session becomes an error that says why, and
// the screen closes the shell it did not ask for.

import { create } from 'zustand';
import type { WireEvent } from '@patch/wire';

export type TerminalStatus = 'starting' | 'live' | 'ended' | 'error';

/**
 * Whether a dead session should reopen itself: `no` (the user's call, or a
 * failure — only Restart), `after-offline` (the machine said it is shutting
 * down; wait until it has really gone), `now` (link or machine gone — reopen
 * once both are back).
 */
export type TerminalReopen = 'no' | 'after-offline' | 'now';

export interface HostTerminal {
  sessionId: string;
  hostId: string;
  /** Where the shell was asked to start, then where it really did. */
  cwd: string;
  status: TerminalStatus;
  reopen: TerminalReopen;
  /** Everything the shell has printed, oldest first. */
  output: string[];
  /** Total characters in `output`, for the cap. */
  outputChars: number;
  /**
   * How many chunks have EVER been appended. `output` loses chunks off the
   * front at the cap, so its length cannot say what is new; this can.
   */
  outputTotal: number;
  /** Why the session is not live, in words — set with `ended` / `error`. */
  message: string | null;
  /**
   * The host opened a pipe shell instead of a terminal. The screen must
   * close it: nothing will drive it, and it would otherwise idle on the host
   * for half an hour.
   */
  wrongKind: boolean;
}

/** Scrollback kept for a redraw. Older output is dropped from the front. */
export const MAX_OUTPUT_CHARS = 1_000_000;

export const TOO_OLD_MESSAGE =
  'This host cannot open an interactive terminal. Update it from Settings → Hosts.';

const EXIT_WORDS: Record<Extract<WireEvent, { type: 'patch.terminal.exit' }>['reason'], string> = {
  shell_exit: 'Shell exited',
  closed: 'Session closed',
  idle_timeout: 'Closed after 30 minutes with no input',
  daemon_shutdown: 'The host restarted',
};

/**
 * The output a view has not drawn yet, given how many chunks it has drawn
 * (`drawn`, counted like `outputTotal`). A view that fell behind the cap gets
 * everything still retained — the dropped front is gone for everyone.
 */
export function undrawn(s: HostTerminal, drawn: number): string {
  const missing = Math.min(s.outputTotal - drawn, s.output.length);
  return missing <= 0 ? '' : s.output.slice(s.output.length - missing).join('');
}

interface TerminalState {
  sessions: Record<string, HostTerminal>;
  /** Register a session the caller is about to open on the wire. */
  start(sessionId: string, hostId: string, cwd: string): void;
  /** Mark a session failed from this side (the open could not even be sent). */
  fail(sessionId: string, message: string): void;
  /** Feed a host → surface terminal frame in. Unknown sessions are ignored. */
  ingest(event: WireEvent): void;
  /**
   * The link to the shell is gone with no exit frame coming (socket dropped,
   * machine went offline): a `live` session would lie. Ends every starting/live
   * session (of `hostId`, or all when omitted) and marks it to reopen.
   */
  interrupt(message: string, hostId?: string): void;
  /** Forget a session (its screen is gone). */
  remove(sessionId: string): void;
  _reset(): void;
}

function patch(
  state: TerminalState,
  sessionId: string,
  fn: (s: HostTerminal) => HostTerminal,
): Partial<TerminalState> {
  const s = state.sessions[sessionId];
  if (!s) return {};
  return { sessions: { ...state.sessions, [sessionId]: fn(s) } };
}

function append(s: HostTerminal, data: string): HostTerminal {
  const output = [...s.output, data];
  let outputChars = s.outputChars + data.length;
  while (outputChars > MAX_OUTPUT_CHARS && output.length > 1) {
    outputChars -= (output.shift() as string).length;
  }
  return { ...s, output, outputChars, outputTotal: s.outputTotal + 1 };
}

export const useTerminalStore = create<TerminalState>((set) => ({
  sessions: {},

  start: (sessionId, hostId, cwd) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          sessionId,
          hostId,
          cwd,
          status: 'starting',
          reopen: 'no',
          output: [],
          outputChars: 0,
          outputTotal: 0,
          message: null,
          wrongKind: false,
        },
      },
    })),

  fail: (sessionId, message) =>
    set((state) =>
      patch(state, sessionId, (s) => ({ ...s, status: 'error', reopen: 'no', message })),
    ),

  interrupt: (message, hostId) =>
    set((state) => {
      const sessions = { ...state.sessions };
      let changed = false;
      for (const [id, s] of Object.entries(state.sessions)) {
        if (hostId !== undefined && s.hostId !== hostId) continue;
        if (s.status === 'starting' || s.status === 'live') {
          sessions[id] = { ...s, status: 'ended', reopen: 'now', message };
          changed = true;
        } else if (s.reopen === 'after-offline') {
          sessions[id] = { ...s, reopen: 'now' };
          changed = true;
        }
      }
      return changed ? { sessions } : state;
    }),

  ingest: (event) => {
    switch (event.type) {
      case 'patch.terminal.ready':
        set((state) =>
          patch(state, event.sessionId, (s) =>
            event.pty === true
              ? { ...s, status: 'live', cwd: event.cwd }
              : { ...s, status: 'error', reopen: 'no', message: TOO_OLD_MESSAGE, wrongKind: true },
          ),
        );
        return;
      case 'patch.terminal.output':
        set((state) => patch(state, event.sessionId, (s) => append(s, event.data)));
        return;
      case 'patch.terminal.exit':
        set((state) =>
          patch(state, event.sessionId, (s) =>
            // A session this side already refused stays refused — its close
            // is what produced this exit, and "Session closed" would hide why.
            s.status === 'error'
              ? s
              : {
                  ...s,
                  status: 'ended',
                  // The offline can beat this frame: an interrupt already released it.
                  reopen:
                    s.reopen === 'now'
                      ? 'now'
                      : event.reason === 'daemon_shutdown'
                        ? 'after-offline'
                        : 'no',
                  message:
                    event.code !== null && event.reason === 'shell_exit'
                      ? `${EXIT_WORDS[event.reason]} with status ${event.code}`
                      : EXIT_WORDS[event.reason],
                },
          ),
        );
        return;
      case 'patch.terminal.error':
        set((state) =>
          patch(state, event.sessionId, (s) => ({ ...s, status: 'error', reopen: 'no', message: event.message })),
        );
        return;
      default:
        return;
    }
  },

  remove: (sessionId) =>
    set((state) => {
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    }),

  _reset: () => set({ sessions: {} }),
}));
