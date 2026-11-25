// Which microphone dictation records from. Kept per host in localStorage: a
// mic belongs to the machine it is plugged into, not to the account. Empty
// means the system default. A saved device that has been unplugged makes
// getUserMedia reject (OverconstrainedError) and that surfaces to the user
// rather than silently recording from another mic.

const STORAGE_KEY = 'patch.voice.micDeviceId';

export interface MicDevice {
  id: string;
  label: string;
}

export function loadMicDeviceId(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}

export function saveMicDeviceId(id: string): void {
  if (id) localStorage.setItem(STORAGE_KEY, id);
  else localStorage.removeItem(STORAGE_KEY);
}

/** getUserMedia constraints for the chosen mic (system default when none). */
export function micConstraints(): MediaStreamConstraints {
  const id = loadMicDeviceId();
  return { audio: id ? { deviceId: { exact: id } } : true };
}

/** The audio inputs the browser can see. Labels are blank until mic permission is granted. */
export async function listMics(): Promise<MicDevice[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter(
      (d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications',
    )
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

/**
 * The device "System default" currently resolves to. Chromium lists it as a
 * `default` entry labelled "Default - <device>"; null when the browser gives no
 * label (permission not yet granted) — the menu then says plain "System default".
 */
export async function systemDefaultMicName(): Promise<string | null> {
  const all = await navigator.mediaDevices.enumerateDevices();
  const d = all.find((x) => x.kind === 'audioinput' && x.deviceId === 'default');
  const name = d?.label.replace(/^default\s*-\s*/i, '').trim();
  return name ? name : null;
}
