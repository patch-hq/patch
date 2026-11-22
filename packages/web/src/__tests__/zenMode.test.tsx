import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useZenMode } from '../lib/zenMode.js';
import { useUiStore } from '../stores/uiStore.js';

let fullscreenEl: Element | null = null;
const request = vi.fn();
const exit = vi.fn();

beforeEach(() => {
  fullscreenEl = null;
  request.mockReset().mockImplementation(() => {
    fullscreenEl = document.documentElement;
    return Promise.resolve();
  });
  exit.mockReset().mockImplementation(() => {
    fullscreenEl = null;
    return Promise.resolve();
  });
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenEl,
  });
  document.documentElement.requestFullscreen = request;
  document.exitFullscreen = exit;
  useUiStore.setState({ zenMode: false, errors: [] } as never);
});
afterEach(() => useUiStore.setState({ zenMode: false } as never));

describe('useZenMode', () => {
  it('goes full screen when zen turns on and leaves when it turns off', async () => {
    renderHook(() => useZenMode());
    await act(async () => useUiStore.getState().setZenMode(true));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => useUiStore.getState().setZenMode(false));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('leaves zen when full screen ends by another route', async () => {
    renderHook(() => useZenMode());
    await act(async () => useUiStore.getState().setZenMode(true));
    await act(async () => {
      fullscreenEl = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(useUiStore.getState().zenMode).toBe(false);
  });

  it('says so, and leaves zen, when full screen is refused', async () => {
    request.mockImplementation(() => Promise.reject(new Error('denied')));
    renderHook(() => useZenMode());
    await act(async () => useUiStore.getState().setZenMode(true));
    expect(useUiStore.getState().zenMode).toBe(false);
    expect(JSON.stringify(useUiStore.getState().errors)).toContain('denied');
  });
});
