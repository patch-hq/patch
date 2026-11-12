import { describe, expect, it } from 'vitest';
import {
  LEGACY_SERVICE_LABELS,
  SERVICE_LABEL,
  launchdPlist,
  launchdPlistPath,
  legacyLaunchdPlistPath,
} from '../src/installer/service.js';

describe('launchd service label', () => {
  it('is a product id, not a personal one', () => {
    expect(SERVICE_LABEL).toBe('io.github.patch-hq.host');
    expect(SERVICE_LABEL).not.toMatch(/tomchambers/);
  });

  it('is what the plist and its path carry', () => {
    const def = { nodePath: '/n', programPath: '/p', env: {}, home: '/h', uid: 1 };
    expect(launchdPlist(def)).toContain(`<key>Label</key><string>${SERVICE_LABEL}</string>`);
    expect(launchdPlistPath('/h')).toBe(`/h/Library/LaunchAgents/${SERVICE_LABEL}.plist`);
  });

  it('migrates away both older labels', () => {
    expect([...LEGACY_SERVICE_LABELS]).toEqual([
      'me.tomchambers.patch-daemon',
      'me.tomchambers.patch-host',
    ]);
    expect(legacyLaunchdPlistPath('/h', 'me.tomchambers.patch-host')).toBe(
      '/h/Library/LaunchAgents/me.tomchambers.patch-host.plist',
    );
  });
});
