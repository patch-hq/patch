// Permissions are explained then requested at the moment of use, never at
// install (spec/15 § Permissions on first use).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Audio } from 'expo-av';
import * as Notifications from 'expo-notifications';
import { ensurePermission, answerExplainer, usePermissionGate } from '../src/lib/permissionGate';

afterEach(() => {
  vi.restoreAllMocks();
  usePermissionGate.setState({ pending: null });
});

describe('permission gate', () => {
  it('already granted: no modal, no OS request', async () => {
    const req = vi.spyOn(Audio, 'requestPermissionsAsync');
    expect(await ensurePermission('microphone')).toBe(true);
    expect(usePermissionGate.getState().pending).toBeNull();
    expect(req).not.toHaveBeenCalled();
  });

  it('not granted: shows the explainer first, requests only after Continue', async () => {
    vi.spyOn(Audio, 'getPermissionsAsync').mockResolvedValue({ granted: false } as never);
    const req = vi.spyOn(Audio, 'requestPermissionsAsync');
    const p = ensurePermission('microphone');
    await vi.waitFor(() => expect(usePermissionGate.getState().pending?.kind).toBe('microphone'));
    expect(req).not.toHaveBeenCalled();
    answerExplainer(true);
    expect(await p).toBe(true);
    expect(req).toHaveBeenCalledTimes(1);
    expect(usePermissionGate.getState().pending).toBeNull();
  });

  it('Not now: resolves false and never reaches the OS dialog', async () => {
    vi.spyOn(Notifications, 'getPermissionsAsync').mockResolvedValue({ granted: false } as never);
    const req = vi.spyOn(Notifications, 'requestPermissionsAsync');
    const p = ensurePermission('notifications');
    await vi.waitFor(() => expect(usePermissionGate.getState().pending).not.toBeNull());
    answerExplainer(false);
    expect(await p).toBe(false);
    expect(req).not.toHaveBeenCalled();
  });

  it('concurrent callers share one explainer', async () => {
    vi.spyOn(Audio, 'getPermissionsAsync').mockResolvedValue({ granted: false } as never);
    const req = vi.spyOn(Audio, 'requestPermissionsAsync');
    const a = ensurePermission('microphone');
    const b = ensurePermission('microphone');
    await vi.waitFor(() => expect(usePermissionGate.getState().pending).not.toBeNull());
    answerExplainer(true);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(req).toHaveBeenCalledTimes(1);
  });
});

describe('startup', () => {
  it('bootstrap no longer primes permissions', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/lib/bootstrap.ts', import.meta.url), 'utf8'),
    );
    expect(src).not.toMatch(/permissionPriming|runPermissionPriming/);
  });
});
