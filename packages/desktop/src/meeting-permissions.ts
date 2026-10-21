// Meeting mode's three macOS permissions, checked and asked for ahead of a
// meeting (the SPA's "Set up meetings" card and the Start popover) instead of
// surfacing as a prompt, or a silent failure, once the meeting is under way.
//
//   microphone     Electron's systemPreferences (the renderer's getUserMedia)
//   accessibility  `patch-audio accessibility [--prompt]` (the helper is the
//                  process that reads the call app, so it is the one to ask)
//   callAudio      macOS has no way to read this grant. Asking opens the
//                  system-audio tap once; a tap that starts is remembered.
//
// NO FALLBACK: a failed ask rejects with the reason; nothing is assumed granted.

export type MeetingPermissionKind = 'microphone' | 'callAudio' | 'accessibility';
export type MeetingPermissionState = Record<MeetingPermissionKind, boolean>;

export interface PermissionDeps {
  micStatus(): string;
  askMic(): Promise<boolean>;
  accessibility(): Promise<boolean>;
  askAccessibility(): Promise<boolean>;
  /** Opens the system-audio tap and closes it again; rejects if macOS refuses. */
  tapOnce(): Promise<void>;
  readCallAudioGranted(): boolean;
  writeCallAudioGranted(): void;
}

export class MeetingPermissions {
  constructor(private readonly deps: PermissionDeps) {}

  async read(): Promise<MeetingPermissionState> {
    return {
      microphone: this.deps.micStatus() === 'granted',
      callAudio: this.deps.readCallAudioGranted(),
      accessibility: await this.deps.accessibility(),
    };
  }

  async request(kind: MeetingPermissionKind): Promise<MeetingPermissionState> {
    switch (kind) {
      case 'microphone':
        await this.deps.askMic();
        break;
      case 'accessibility':
        await this.deps.askAccessibility();
        break;
      case 'callAudio':
        await this.deps.tapOnce();
        this.deps.writeCallAudioGranted();
        break;
      default:
        throw new Error(`unknown meeting permission ${String(kind)}`);
    }
    return this.read();
  }
}
