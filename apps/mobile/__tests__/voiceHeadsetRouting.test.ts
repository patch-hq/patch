// The Kotlin service cannot run under Node, so this pins its source: a session
// must put Android in communication mode and route to a connected headset, or
// VOICE_COMMUNICATION audio comes out of the phone speaker/earpiece instead.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const kt = readFileSync(new URL('../plugins/native/VoiceAudioService.kt', import.meta.url), 'utf8');

describe('VoiceAudioService headset routing', () => {
  it('enters communication mode and restores the previous mode', () => {
    expect(kt).toContain('MODE_IN_COMMUNICATION');
    expect(kt).toMatch(/previousMode/);
  });
  it('routes to a headset via setCommunicationDevice and clears it', () => {
    expect(kt).toContain('setCommunicationDevice');
    expect(kt).toContain('clearCommunicationDevice');
    for (const t of [
      'TYPE_WIRED_HEADSET',
      'TYPE_WIRED_HEADPHONES',
      'TYPE_USB_HEADSET',
      'TYPE_BLUETOOTH_SCO',
      'TYPE_BLE_HEADSET',
    ])
      expect(kt).toContain(t);
  });
  it('uses Bluetooth SCO below Android 12 and stops it afterwards', () => {
    expect(kt).toContain('startBluetoothSco');
    expect(kt).toContain('stopBluetoothSco');
  });
  it('reports a missing headset route loudly only when one is present but refused', () => {
    expect(kt).toMatch(/setCommunicationDevice\(.*\)[\s\S]*Log\.(w|e)/);
  });
  it('re-routes when a headset is removed or connected mid-call, and stops watching at the end', () => {
    expect(kt).toContain('registerAudioDeviceCallback');
    expect(kt).toContain('onAudioDevicesRemoved');
    expect(kt).toContain('onAudioDevicesAdded');
    expect(kt).toContain('unregisterAudioDeviceCallback');
  });

  it('tells JS when headphones come and go, which pauses and resumes the call', () => {
    expect(kt).toContain('"headset_removed"');
    expect(kt).toContain('"headset_added"');
  });
  it('a paused call keeps watching headphones but releases focus and the route', () => {
    expect(kt).toContain('EXTRA_PAUSED');
    expect(kt).toMatch(
      /if \(paused\) \{[\s\S]*?releaseHeadsetRoute\(\)[\s\S]*?abandonAudioFocus\(\)/,
    );
    // Watching stops only when the service does.
    expect(kt).toMatch(/fun stopWatchingHeadsets/);
    expect(kt).toContain('"Resume"');
  });
  it('a call answered on its own takes transient focus, so paused playback resumes after', () => {
    expect(kt).toContain('AUDIOFOCUS_GAIN_TRANSIENT');
    expect(kt).toContain('EXTRA_TRANSIENT_FOCUS');
  });
  it('promotes to the foreground once and only redraws after, so a resume works from the background', () => {
    expect(kt).toMatch(/if \(!inForeground\) \{\s*startForeground/);
    expect(kt).toContain('mgr.notify(NOTIFICATION_ID');
  });
});
