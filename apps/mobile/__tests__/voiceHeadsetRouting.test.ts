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
});
