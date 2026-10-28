// iOS preparation guards (spec/15 § iOS). A JS suite cannot build for iOS, so
// this pins what Apple rejects at upload and what would silently ship an
// unusable app: missing usage strings, a wrong bundle id, a native module that
// throws instead of reporting "absent" off Android.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import config from '../app.config';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('ios config', () => {
  it('declares ios beside android with a bundle id matching the package', () => {
    expect(config.platforms).toEqual(['android', 'ios']);
    expect(config.ios?.bundleIdentifier).toBe(config.android?.package);
  });

  it('carries every usage string for the permissions the app asks for', () => {
    const plist = config.ios?.infoPlist ?? {};
    for (const key of [
      'NSMicrophoneUsageDescription',
      'NSSpeechRecognitionUsageDescription',
      'NSPhotoLibraryUsageDescription',
      'NSCameraUsageDescription',
    ]) {
      expect(typeof plist[key], key).toBe('string');
      expect((plist[key] as string).length, key).toBeGreaterThan(10);
    }
    expect(plist.UIBackgroundModes).toEqual(
      expect.arrayContaining(['audio', 'remote-notification']),
    );
    expect(plist.ITSAppUsesNonExemptEncryption).toBe(false);
  });

  it('has an EAS ios build profile for the store', () => {
    const eas = JSON.parse(readFileSync(join(root, 'eas.json'), 'utf8'));
    expect(eas.build.ios.distribution).toBe('store');
    expect(eas.submit.ios).toBeDefined();
  });

  it('keeps every Android-only native module guarded by a platform check', () => {
    const libs = join(root, 'src/lib');
    const offenders = readdirSync(libs)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => {
        const src = readFileSync(join(libs, f), 'utf8');
        return /NativeModules/.test(src) && !/Platform\.OS\s*!==\s*'android'/.test(src);
      });
    expect(offenders).toEqual([]);
  });
});
