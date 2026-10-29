import { describe, it, expect, afterEach } from 'vitest';
import { noteInstallingUpdate, shutdownReason } from '../src/shutdown-reason.js';

describe('shutdownReason', () => {
  afterEach(() => noteInstallingUpdate(false));

  it('is a plain restart unless this server launched an update install', () => {
    expect(shutdownReason()).toBe('restarting');
  });

  it('says updating once the installer for a new release has been launched', () => {
    noteInstallingUpdate(true);
    expect(shutdownReason()).toBe('updating');
  });
});
