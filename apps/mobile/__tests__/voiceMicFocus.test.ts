// The native microphone (MicCapture, shared by PatchVoiceMic and a call's
// transport) can't run under Node, so this guards its source: it must take
// transient-exclusive audio focus when it opens (so other phone audio pauses
// while the user talks) and give it back on stop, start failure and teardown,
// and the prebuild copy must match the plugin source.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const plugin = readFileSync(resolve(root, 'plugins/native/MicCapture.kt'), 'utf8');
const android = readFileSync(
  resolve(root, 'android/app/src/main/java/dev/patchhq/app/MicCapture.kt'),
  'utf8',
);
const micModule = readFileSync(resolve(root, 'plugins/native/PatchVoiceMicModule.kt'), 'utf8');
/** The body of `fun <name>(` up to the next top-level member. */
function body(name: string): string {
  const at = plugin.indexOf(`fun ${name}(`);
  expect(at).toBeGreaterThan(-1);
  const next = plugin.indexOf('\n  fun ', at + 1);
  const priv = plugin.indexOf('\n  private fun ', at + 1);
  const end = [next, priv].filter((i) => i > -1).sort((a, b) => a - b)[0] ?? plugin.length;
  return plugin.slice(at, end);
}

describe('PatchVoiceMic audio focus', () => {
  it('requests transient-exclusive focus before recording starts', () => {
    expect(plugin).toContain('AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE');
    expect(plugin.indexOf('requestFocus()\n      rec.startRecording()')).toBeGreaterThan(-1);
  });
  it('gives focus back and stops watching devices on stop; a failed start stops', () => {
    expect(body('stop')).toContain('abandonFocus()');
    expect(body('stop')).toContain('unwatchDevices()');
    expect(body('start')).toMatch(/catch \(e: Throwable\) \{\s*stop\(\)/);
  });
  it('reports focus taken and devices coming or going', () => {
    expect(plugin).toContain('.setOnAudioFocusChangeListener(focusListener)');
    expect(plugin).toContain('audioStopped("audio_focus_taken"');
    expect(plugin).toContain('audioStopped("output_device_changed"');
  });
  it('the JS-facing module releases the microphone on stop and teardown', () => {
    expect(micModule.match(/capture\.stop\(\)/g)!.length).toBe(2);
  });
  it('keeps the android copy identical to the plugin source', () => {
    expect(android).toBe(plugin);
  });
});
