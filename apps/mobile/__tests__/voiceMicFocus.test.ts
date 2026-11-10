// The native mic module can't run under Node, so this guards its source: the
// mic must take transient-exclusive audio focus when it opens (so other phone
// audio pauses during dictation) and give it back on stop/failure/teardown,
// and the prebuild copy must match the plugin source.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const plugin = readFileSync(resolve(root, 'plugins/native/PatchVoiceMicModule.kt'), 'utf8');
const android = readFileSync(
  resolve(root, 'android/app/src/main/java/io/github/tomchambers2/patch/PatchVoiceMicModule.kt'),
  'utf8',
);

describe('PatchVoiceMic audio focus', () => {
  it('requests transient-exclusive focus before recording starts', () => {
    expect(plugin).toContain('AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE');
    expect(plugin.indexOf('requestFocus()\n      rec.startRecording()')).toBeGreaterThan(-1);
  });
  it('abandons focus on start failure, stop and invalidate', () => {
    expect(plugin.match(/abandonFocus\(\)/g)!.length).toBe(4); // 3 call sites + definition
  });
  it('keeps the android copy identical to the plugin source', () => {
    expect(android).toBe(plugin);
  });
});
