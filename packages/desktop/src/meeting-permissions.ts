// Meeting mode's three macOS permissions, so the web app can ask for them
// before a meeting rather than failing at its start:
//   microphone    — Tom's side of the call
//   callAudio     — System Audio Recording, the other side (the helper's tap)
//   accessibility — reading who is speaking from the calling app
// macOS can say whether the first and last are allowed; System Audio Recording
// can only be tried, so it reads `unknown` until a probe or a meeting proves it.

export type MeetingPermissionKind = 'microphone' | 'callAudio' | 'accessibility';
export type MeetingPermissionState = 'granted' | 'missing' | 'unknown';
export type MeetingPermissions = Record<MeetingPermissionKind, MeetingPermissionState>;

export interface MeetingPermissionDeps {
  /** Electron's `systemPreferences.getMediaAccessStatus('microphone')`. */
  micStatus(): string;
  /** Electron's `systemPreferences.askForMediaAccess('microphone')`. */
  askMic(): Promise<boolean>;
  /** Electron's `systemPreferences.isTrustedAccessibilityClient(prompt)`. */
  accessibilityTrusted(prompt: boolean): boolean;
  /** `patch-audio probe`: resolves when System Audio Recording is allowed. */
  probeCallAudio(): Promise<void>;
  /** Whether System Audio Recording has worked on this Mac before. */
  callAudioKnown(): boolean;
  rememberCallAudio(): void;
}

export function readMeetingPermissions(d: MeetingPermissionDeps): MeetingPermissions {
  return {
    microphone: d.micStatus() === 'granted' ? 'granted' : 'missing',
    callAudio: d.callAudioKnown() ? 'granted' : 'unknown',
    accessibility: d.accessibilityTrusted(false) ? 'granted' : 'missing',
  };
}

/**
 * Asks macOS for one permission and says where it stands afterwards. Accessibility
 * only opens System Settings: it is granted there, so it reads `missing` until
 * Tom has switched it on and the app checks again.
 */
export async function requestMeetingPermission(
  kind: MeetingPermissionKind,
  d: MeetingPermissionDeps,
): Promise<MeetingPermissionState> {
  switch (kind) {
    case 'microphone':
      return (await d.askMic()) ? 'granted' : 'missing';
    case 'accessibility':
      return d.accessibilityTrusted(true) ? 'granted' : 'missing';
    case 'callAudio':
      await d.probeCallAudio();
      d.rememberCallAudio();
      return 'granted';
  }
}
