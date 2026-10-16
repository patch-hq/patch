// Settings → Computer use on the phone: the "Patch is using your computer"
// state with hands-off copy and Stop, and the idle states.

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComputerUsePage } from '../src/components/settings/ComputerUseSection';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __resetRouterMock } from './stubs/expo-router';
import { resetHosts } from './testUtils/settingsFixtures';

vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: vi.fn() }) }));
vi.mock('../src/api/rest', () => ({
  api: { computerUse: vi.fn(), stopComputerUse: vi.fn(), settings: vi.fn() },
}));

type R = ReturnType<typeof renderRN>;
const mounted: R[] = [];
async function mount(): Promise<R> {
  const r = renderRN(<ComputerUsePage />);
  mounted.push(r);
  await flush();
  return r;
}

beforeEach(() => {
  __resetRouterMock();
  resetHosts();
});
afterEach(() => {
  for (const r of mounted.splice(0)) {
    try {
      act(() => r.unmount());
    } catch {
      /* already gone */
    }
  }
});

describe('Settings → Computer use (phone)', () => {
  it('says Patch is using the computer, and Stop cancels it', async () => {
    vi.mocked(api.computerUse)
      .mockReset()
      .mockResolvedValueOnce({
        hosts: [{ hostId: 'd1', name: 'Mac', active: true, actionLabel: 'Clicking', tabs: 1 }],
      })
      .mockResolvedValue({ hosts: [{ hostId: 'd1', name: 'Mac', active: false, tabs: 0 }] });
    vi.mocked(api.stopComputerUse)
      .mockReset()
      .mockResolvedValue({ hostId: 'd1', name: 'Mac', active: false, tabs: 0, closed: 1 });
    const r = await mount();
    expect(textOf(findHost(r.root, byTestId('computer-use-active')))).toContain(
      'Patch is using Mac right now',
    );
    await actAsync(() => {
      findHost(r.root, byTestId('computer-use-stop')).props['onPress']();
    });
    await flush();
    expect(api.stopComputerUse).toHaveBeenCalledWith('d1');
    expect(queryHost(r.root, byTestId('computer-use-active'))).toBeNull();
  });

  it('shows a machine that did not answer as unchecked, not idle', async () => {
    vi.mocked(api.computerUse)
      .mockReset()
      .mockResolvedValue({ hosts: [{ hostId: 'd1', name: 'Mac', error: 'did not answer' }] });
    const r = await mount();
    expect(textOf(findHost(r.root, byTestId('computer-use-d1')))).toContain('did not answer');
  });
});
