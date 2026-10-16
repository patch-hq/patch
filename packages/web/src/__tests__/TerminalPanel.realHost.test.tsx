// The chat terminal against a REAL host shell (spec/14 § Terminal).
//
// TerminalPanel.test.tsx drives the panel against a stub socket, so it can only
// prove the frames the panel sends — never that those frames make a working
// shell. Here the socket is wired straight into the host's own TerminalSessions
// (a real bash on real pipes) and the host's frames are fed back through the
// store, exactly as the app's WS router does. Every test is a user interaction:
// type, press a key, read the screen.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { TerminalSessions } from '../../../host/src/terminal.js';
import { TerminalPanel } from '../components/TerminalPanel.js';
import { useTerminalStore } from '../stores/terminalStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

let host: TerminalSessions;
let dir: string;
let sent: WireEvent[];

function mount(folder: string | undefined = dir, chatId = 'c1'): void {
  const ws = {
    send: (e: WireEvent): void => {
      sent.push(e);
      host.handle(e as Parameters<TerminalSessions['handle']>[0]);
    },
  };
  render(
    <TerminalPanel
      chatId={chatId}
      folder={folder}
      ws={ws as unknown as Parameters<typeof TerminalPanel>[0]['ws']}
    />,
  );
}

const scroll = (): string => screen.getByTestId('terminal-scroll').textContent ?? '';
const input = (): HTMLInputElement => screen.getByTestId('terminal-input') as HTMLInputElement;

async function live(): Promise<void> {
  await waitFor(() => expect(useTerminalStore.getState().sessions['c1']?.status).toBe('live'));
}

function type(cmd: string): void {
  fireEvent.change(input(), { target: { value: cmd } });
  fireEvent.keyDown(input(), { key: 'Enter' });
}

const idle = (): void =>
  void expect(screen.getByTestId('terminal-prompt-row')).toHaveAttribute('data-running', 'false');

describe('TerminalPanel against a real host shell', () => {
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'term-real-')));
    sent = [];
    useTerminalStore.getState()._reset();
    usePresenceStore
      .getState()
      .setHosts([{ hostId: 'd1', online: true, lastSeenAt: null, host: null, accounts: [] }]);
    host = new TerminalSessions({
      emit: (e) => useTerminalStore.getState().ingest(e),
    });
  });

  afterEach(async () => {
    cleanup();
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a shell rooted in the chat folder and the header shows it', async () => {
    mount();
    await live();
    expect(screen.getByTitle(dir)).toBeInTheDocument();
  });

  it('a typed command runs and its output appears under the echoed line', async () => {
    mount();
    await live();
    type('echo hello-from-host');
    await waitFor(() => expect(scroll()).toContain('hello-from-host'));
    expect(scroll()).toContain('❯ echo hello-from-host');
  });

  it('the running indicator appears while a command runs and clears when it finishes', async () => {
    mount();
    await live();
    type('sleep 0.5');
    expect(screen.getByTestId('terminal-running')).toHaveTextContent('⌃C interrupts');
    await waitFor(() => expect(screen.queryByTestId('terminal-running')).toBeNull());
    idle();
  });

  it('a silent command (cd) finishes and the next command runs in the new directory', async () => {
    mount();
    await live();
    type('mkdir sub && cd sub');
    await waitFor(() => idle());
    type('pwd');
    await waitFor(() => expect(scroll()).toContain(join(dir, 'sub')));
  });

  it('reads files in the folder', async () => {
    writeFileSync(join(dir, 'marker.txt'), 'x');
    mount();
    await live();
    type('ls');
    await waitFor(() => expect(scroll()).toContain('marker.txt'));
  });

  it('a failing command is reported with its exit status and stderr', async () => {
    mount();
    await live();
    type('ls /definitely/not/here');
    await waitFor(() => expect(scroll()).toContain('exit '));
    expect(scroll()).toMatch(/No such file/);
    idle();
  });

  it('Ctrl-C interrupts a long command and the shell takes the next one', async () => {
    mount();
    await live();
    type('sleep 30');
    expect(screen.getByTestId('terminal-running')).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: 'c', ctrlKey: true });
    expect(scroll()).toContain('^C');
    await waitFor(() => idle());
    type('echo still-alive');
    await waitFor(() => expect(scroll()).toContain('still-alive'));
  });

  it('↑ recalls the previous command and Enter re-runs it', async () => {
    mount();
    await live();
    type('echo again');
    await waitFor(() => idle());
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().value).toBe('echo again');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(scroll().match(/again\n/g)?.length).toBeGreaterThanOrEqual(3));
  });

  it('the input clears after submit', async () => {
    mount();
    await live();
    type('true');
    expect(input().value).toBe('');
  });

  it('an empty Enter does not wedge the prompt', async () => {
    mount();
    await live();
    type('');
    await waitFor(() => idle());
    type('echo after-blank');
    await waitFor(() => expect(scroll()).toContain('after-blank'));
  });

  it('several commands in a row each finish, in order', async () => {
    mount();
    await live();
    type('echo one');
    type('echo two');
    type('echo three');
    await waitFor(() => expect(scroll()).toContain('three\n'));
    await waitFor(() => idle());
    const s = scroll();
    expect(s.lastIndexOf('one\n')).toBeLessThan(s.lastIndexOf('two\n'));
    expect(s.lastIndexOf('two\n')).toBeLessThan(s.lastIndexOf('three\n'));
  });

  it('exit ends the session, says so, and Restart brings a fresh shell back', async () => {
    mount();
    await live();
    type('exit 3');
    await waitFor(() => expect(scroll()).toContain('[session ended'));
    expect(scroll()).toContain('exit 3');
    expect(screen.queryByTestId('terminal-input')).toBeNull();
    fireEvent.click(screen.getByTestId('terminal-restart'));
    await live();
    type('echo reborn');
    await waitFor(() => expect(scroll()).toContain('reborn'));
  });

  it('a folder that does not exist is a loud error, not a shell elsewhere', async () => {
    mount(join(dir, 'missing'));
    await waitFor(() => expect(scroll()).toContain('[error'));
    expect(screen.getByTestId('terminal-restart')).toBeInTheDocument();
  });

  it('with no folder (new chat) the host roots the shell and the header shows where', async () => {
    mount(undefined, 'new');
    await waitFor(() => expect(useTerminalStore.getState().sessions['new']?.status).toBe('live'));
    expect(useTerminalStore.getState().sessions['new']?.folder).not.toBe('');
  });

  it('closing and reopening the tab re-attaches to the same running shell', async () => {
    mount();
    await live();
    type('export KEPT=yes');
    await waitFor(() => idle());
    cleanup();
    mount();
    expect(scroll()).toContain('❯ export KEPT=yes');
    type('echo $KEPT');
    await waitFor(() => expect(scroll()).toContain('yes\n'));
    expect(sent.filter((e) => e.type === 'patch.terminal.open')).toHaveLength(1);
  });

  it('long output keeps the view scrolled to the tail', async () => {
    mount();
    await live();
    type('seq 1 500');
    await waitFor(() => expect(scroll()).toContain('500\n'));
    const el = screen.getByTestId('terminal-scroll');
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  it('multi-byte output arrives intact', async () => {
    mount();
    await live();
    type('printf "caf\\xc3\\xa9 \\xe2\\x9c\\x93\\n"');
    await waitFor(() => expect(scroll()).toContain('café ✓'));
  });

  it('a stdin-reading command stays marked running until Ctrl-C', async () => {
    mount();
    await live();
    type('cat');
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByTestId('terminal-running')).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: 'c', ctrlKey: true });
    await waitFor(() => idle());
  });

  it('with no host registered the panel says so instead of opening anything', async () => {
    usePresenceStore.getState().setHosts([]);
    mount();
    await waitFor(() => expect(scroll()).toContain('no host to open a shell on'));
    expect(screen.getByTestId('terminal-restart')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });
});
