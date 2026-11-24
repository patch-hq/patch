import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listMics, loadMicDeviceId, micConstraints, saveMicDeviceId } from '../lib/micDevice.js';

describe('micDevice', () => {
  beforeEach(() => localStorage.clear());

  it('asks for the system default until a mic is chosen', () => {
    expect(loadMicDeviceId()).toBe('');
    expect(micConstraints()).toEqual({ audio: true });
  });

  it('requires the chosen device exactly, and clears back to default', () => {
    saveMicDeviceId('abc');
    expect(micConstraints()).toEqual({ audio: { deviceId: { exact: 'abc' } } });
    saveMicDeviceId('');
    expect(micConstraints()).toEqual({ audio: true });
  });

  it('lists only real audio inputs, naming unlabelled ones', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'default', label: 'Default' },
          { kind: 'audioinput', deviceId: 'a', label: 'USB Mic' },
          { kind: 'audioinput', deviceId: 'b', label: '' },
          { kind: 'videoinput', deviceId: 'v', label: 'Cam' },
        ],
      },
    });
    expect(await listMics()).toEqual([
      { id: 'a', label: 'USB Mic' },
      { id: 'b', label: 'Microphone 2' },
    ]);
    vi.unstubAllGlobals();
  });
});
