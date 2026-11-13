// Mobile Stray process bar (spec/15 § Chat detail): a `nohup … &` the chat left
// running is listed with its command and elapsed time and can be stopped; a
// host that cannot detect them shows nothing, any other failure shows.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { StrayProcessRow } from '@patch/wire';
import { renderRN, queryHost, findAllHost, byTestId, textOf } from './testUtils/render';
import { StrayProcessBar } from '../src/components/StrayProcessBar';

const apiMocks = vi.hoisted(() => ({
  strayProcesses: vi.fn(),
  strayProcessStop: vi.fn(),
}));
vi.mock('../src/api/rest', () => ({ api: apiMocks }));

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

async function mount(): Promise<ReturnType<typeof renderRN>> {
  const r = renderRN(<StrayProcessBar chatId="c1" />);
  await act(async () => {
    await Promise.resolve();
  });
  return r;
}

beforeEach(() => {
  apiMocks.strayProcesses.mockReset();
  apiMocks.strayProcessStop.mockReset();
});

describe('StrayProcessBar (mobile)', () => {
  it('renders nothing when the chat has none', async () => {
    apiMocks.strayProcesses.mockResolvedValue({ processes: [] });
    const r = await mount();
    expect(queryHost(r.root, byTestId('stray-process-bar'))).toBeNull();
  });

  it('lists a running process with its command and elapsed time', async () => {
    apiMocks.strayProcesses.mockResolvedValue({ processes: [running] });
    const r = await mount();
    expect(textOf(queryHost(r.root, byTestId('stray-process-command'))!)).toBe(running.command);
    expect(textOf(findAllHost(r.root, byTestId('stray-process-row'))[0]!)).toMatch(/20m/);
  });

  it('stopping calls the host for that pid and redraws from the answer', async () => {
    apiMocks.strayProcesses.mockResolvedValue({ processes: [running] });
    apiMocks.strayProcessStop.mockResolvedValue({
      stopped: true,
      processes: [{ ...running, running: false, endedAt: Date.now() }],
    });
    const r = await mount();
    await act(async () => {
      queryHost(r.root, byTestId('stray-process-stop'))!.props.onPress();
      await Promise.resolve();
    });
    expect(apiMocks.strayProcessStop).toHaveBeenCalledWith('c1', 4321);
    expect(queryHost(r.root, byTestId('stray-process-stop'))).toBeNull();
  });

  it('hides ended processes behind "show ended"', async () => {
    apiMocks.strayProcesses.mockResolvedValue({ processes: [running, ended] });
    const r = await mount();
    expect(findAllHost(r.root, byTestId('stray-process-row'))).toHaveLength(1);
    await act(async () => {
      queryHost(r.root, byTestId('stray-process-show-ended'))!.props.onPress();
    });
    expect(findAllHost(r.root, byTestId('stray-process-row'))).toHaveLength(2);
  });

  it('shows nothing on a host that cannot detect them (501)', async () => {
    apiMocks.strayProcesses.mockRejectedValue(Object.assign(new Error('x'), { status: 501 }));
    const r = await mount();
    expect(queryHost(r.root, byTestId('stray-process-bar'))).toBeNull();
  });

  it('shows any other failure rather than an empty list', async () => {
    apiMocks.strayProcesses.mockRejectedValue(
      Object.assign(new Error('daemon_timeout'), { status: 504 }),
    );
    const r = await mount();
    expect(textOf(queryHost(r.root, byTestId('stray-process-error'))!)).toContain('daemon_timeout');
  });
});
