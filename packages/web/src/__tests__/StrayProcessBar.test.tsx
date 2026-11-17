// spec/14 § Main chat panel — Stray process bar. A `nohup … &` the chat left
// running is listed with its command and elapsed time and can be stopped; a
// host that cannot detect them shows nothing, any other failure shows.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import type { StrayProcessRow } from '@patch/wire';

const strayProcesses = vi.fn();
const strayProcessStop = vi.fn();

vi.mock('../api/rest.js', async () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      strayProcesses: (...a: unknown[]) => strayProcesses(...a),
      strayProcessStop: (...a: unknown[]) => strayProcessStop(...a),
    },
  };
});

import { StrayProcessBar } from '../components/StrayProcessBar.js';
import { ApiError } from '../api/rest.js';

const running: StrayProcessRow = {
  pid: 4321,
  command: 'node long-run.js --flag',
  startedAt: Date.now() - 20 * 60_000,
  running: true,
};
const ended: StrayProcessRow = {
  pid: 99,
  command: 'sleep 5',
  startedAt: Date.now() - 60_000,
  running: false,
  endedAt: Date.now() - 30_000,
};

async function mount(): Promise<void> {
  render(<StrayProcessBar chatId="c1" />);
  await act(async () => {});
}

beforeEach(() => {
  strayProcesses.mockReset();
  strayProcessStop.mockReset();
});
afterEach(cleanup);

describe('StrayProcessBar', () => {
  it('renders nothing when the chat has none', async () => {
    strayProcesses.mockResolvedValue({ processes: [] });
    await mount();
    expect(screen.queryByTestId('stray-process-bar')).toBeNull();
  });

  it('lists a running process with its command and elapsed time', async () => {
    strayProcesses.mockResolvedValue({ processes: [running] });
    await mount();
    expect(screen.getByTestId('stray-process-command').textContent).toBe(running.command);
    expect(screen.getByTestId('stray-process-row').getAttribute('data-ended')).toBe('false');
    expect(screen.getByTestId('stray-process-row').textContent).toMatch(/20m/);
  });

  it('stopping a process calls the host for that pid and redraws from the answer', async () => {
    strayProcesses.mockResolvedValue({ processes: [running] });
    strayProcessStop.mockResolvedValue({
      stopped: true,
      processes: [{ ...running, running: false, endedAt: Date.now() }],
    });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('stray-process-kill'));
    });
    expect(strayProcessStop).toHaveBeenCalledWith('c1', 4321);
    expect(screen.queryByTestId('stray-process-kill')).toBeNull();
  });

  it('hides ended processes behind "show ended"', async () => {
    strayProcesses.mockResolvedValue({ processes: [running, ended] });
    await mount();
    expect(screen.getAllByTestId('stray-process-row')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('stray-process-show-ended'));
    const rows = screen.getAllByTestId('stray-process-row');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.getAttribute('data-ended')).toBe('true');
  });

  it('shows nothing on a host that cannot detect them (501)', async () => {
    strayProcesses.mockRejectedValue(new ApiError(501, 'unsupported', null));
    await mount();
    expect(screen.queryByTestId('stray-process-bar')).toBeNull();
  });

  it('shows any other failure rather than an empty list', async () => {
    strayProcesses.mockRejectedValue(new ApiError(504, 'daemon_timeout', null));
    await mount();
    expect(screen.getByTestId('stray-process-error').textContent).toContain('daemon_timeout');
  });
});
