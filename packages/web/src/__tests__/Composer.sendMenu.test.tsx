// Right-click on the send button: "Scheduled send" and
// "Send, wait until agent finished".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportAccount } from './presenceHelpers.js';

function open(
  props: Partial<React.ComponentProps<typeof Composer>> = {},
): ReturnType<typeof vi.fn> {
  const onSend = vi.fn();
  render(
    <Composer chatId="c1" hostId="d1" onSend={onSend} onStartVoiceNote={() => {}} {...props} />,
  );
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'ship it' } });
  fireEvent.contextMenu(screen.getByTestId('send-btn'), { clientX: 50, clientY: 50 });
  return onSend;
}

describe('Composer send-button context menu', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
  });
  afterEach(cleanup);

  it('offers both options', () => {
    open({ onScheduleSend: async () => {} });
    expect(screen.getByText('Scheduled send')).toBeTruthy();
    expect(screen.getByText('Send, wait until agent finished')).toBeTruthy();
  });

  it('"Send, wait until agent finished" sends the text while a turn runs (queued, not interrupting)', () => {
    const onStop = vi.fn();
    const onSend = open({ running: true, onStop });
    fireEvent.click(screen.getByText('Send, wait until agent finished'));
    expect(onSend).toHaveBeenCalledWith('ship it', undefined, undefined, { afterTurn: true });
    expect(onStop).not.toHaveBeenCalled();
  });

  it('"Scheduled send" schedules the typed text at the chosen time and clears the box', async () => {
    const onScheduleSend = vi.fn(async () => {});
    const onSend = open({ onScheduleSend });
    fireEvent.click(screen.getByText('Scheduled send'));
    const future = new Date(Date.now() + 2 * 3600_000);
    future.setMinutes(future.getMinutes() - future.getTimezoneOffset());
    const local = future.toISOString().slice(0, 16);
    fireEvent.change(screen.getByTestId('schedule-at'), { target: { value: local } });
    fireEvent.click(screen.getByTestId('schedule-confirm'));
    await waitFor(() => expect(onScheduleSend).toHaveBeenCalledTimes(1));
    const [msg, at] = onScheduleSend.mock.calls[0] as unknown as [string, string];
    expect(msg).toBe('ship it');
    expect(Math.abs(Date.parse(at) - Date.parse(local))).toBeLessThan(
      Date.parse(local) - Date.now() + 120_000,
    );
    expect(new Date(at).getTime()).toBeGreaterThan(Date.now());
    await waitFor(() =>
      expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe(''),
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('rejects a time in the past and keeps the text', async () => {
    const onScheduleSend = vi.fn(async () => {});
    open({ onScheduleSend });
    fireEvent.click(screen.getByText('Scheduled send'));
    fireEvent.change(screen.getByTestId('schedule-at'), { target: { value: '2020-01-01T10:00' } });
    fireEvent.click(screen.getByTestId('schedule-confirm'));
    expect(await screen.findByTestId('schedule-error')).toBeTruthy();
    expect(onScheduleSend).not.toHaveBeenCalled();
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('ship it');
  });

  it('shows a scheduling failure and keeps the text (no silent fallback)', async () => {
    open({
      onScheduleSend: async () => {
        throw new Error('host offline');
      },
    });
    fireEvent.click(screen.getByText('Scheduled send'));
    const future = new Date(Date.now() + 3600_000);
    future.setMinutes(future.getMinutes() - future.getTimezoneOffset());
    fireEvent.change(screen.getByTestId('schedule-at'), {
      target: { value: future.toISOString().slice(0, 16) },
    });
    fireEvent.click(screen.getByTestId('schedule-confirm'));
    expect((await screen.findByTestId('schedule-error')).textContent).toBe('host offline');
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('ship it');
  });

  it('"Add to todo list" hands the text to onAddToTodo, clears the box and does not send', async () => {
    const onAddToTodo = vi.fn(async () => true);
    const onSend = open({ onAddToTodo });
    fireEvent.click(screen.getByText('Add to todo list'));
    await waitFor(() => expect(onAddToTodo).toHaveBeenCalledWith('ship it', []));
    await waitFor(() =>
      expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe(''),
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('"Add to todo list" keeps the text when the add reports failure', async () => {
    const onAddToTodo = vi.fn(async () => false);
    open({ onAddToTodo });
    fireEvent.click(screen.getByText('Add to todo list'));
    await waitFor(() => expect(onAddToTodo).toHaveBeenCalled());
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('ship it');
  });

  it('has no "Add to todo list" item when the surface cannot add to a list', () => {
    open();
    expect(screen.queryByText('Add to todo list')).toBeNull();
  });
});

describe('Composer send-button menu: interrupt', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
  });
  afterEach(cleanup);

  it('"Send, interrupt immediately" sends with interrupt and clears the box', () => {
    const onSend = open({ running: true, onStop: vi.fn() });
    fireEvent.click(screen.getByText('Send, interrupt immediately'));
    expect(onSend).toHaveBeenCalledWith('ship it', undefined, undefined, { interrupt: true });
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('');
  });
});
