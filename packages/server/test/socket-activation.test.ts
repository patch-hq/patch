import { describe, expect, it } from 'vitest';
import { activatedFd } from '../src/socket-activation.js';

describe('activatedFd', () => {
  it('is undefined when not started by a socket unit', () => {
    expect(activatedFd({}, 10)).toBeUndefined();
  });
  it('is fd 3 when systemd passed one socket to this process', () => {
    expect(activatedFd({ LISTEN_PID: '10', LISTEN_FDS: '1' }, 10)).toBe(3);
  });
  it('ignores variables inherited from another process', () => {
    expect(activatedFd({ LISTEN_PID: '9', LISTEN_FDS: '1' }, 10)).toBeUndefined();
  });
  it('refuses anything but exactly one socket', () => {
    expect(() => activatedFd({ LISTEN_PID: '10', LISTEN_FDS: '2' }, 10)).toThrow(/exactly one/);
    expect(() => activatedFd({ LISTEN_PID: '10' }, 10)).toThrow(/exactly one/);
  });
});
