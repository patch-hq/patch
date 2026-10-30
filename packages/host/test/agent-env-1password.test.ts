import { describe, expect, it } from 'vitest';
import { buildSdkEnv } from '../src/sdkBackend.js';

describe('agent environment', () => {
  it('switches the 1Password desktop-app integration off, whatever the host has', () => {
    process.env['OP_BIOMETRIC_UNLOCK_ENABLED'] = 'true';
    try {
      const { env } = buildSdkEnv({
        prompt: 'x',
        cwd: '/tmp',
        abortController: new AbortController(),
      });
      expect(env['OP_BIOMETRIC_UNLOCK_ENABLED']).toBe('false');
    } finally {
      delete process.env['OP_BIOMETRIC_UNLOCK_ENABLED'];
    }
  });
});
