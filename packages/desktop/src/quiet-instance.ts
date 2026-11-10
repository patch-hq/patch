// A second Patch that disturbs nobody: its own data folder, windows that never
// show or take focus, and no OS notifications. Used by the synthetic meeting test
// (scripts/meeting-e2e), which runs beside the app someone is using. Off unless
// PATCH_USER_DATA_DIR is set; nothing here is a fallback for anything.

export interface QuietInstance {
  /** Replaces Electron's userData folder, so nothing is shared with a running Patch. */
  userDataDir: string;
  /** Windows are created hidden, nothing is raised or focused, toasts are only logged. */
  quiet: true;
}

export function quietInstanceFromEnv(env: NodeJS.ProcessEnv): QuietInstance | null {
  const dir = env['PATCH_USER_DATA_DIR'];
  if (dir === undefined || dir === '') return null;
  if (!dir.startsWith('/')) throw new Error('PATCH_USER_DATA_DIR must be an absolute path');
  return { userDataDir: dir, quiet: true };
}

/**
 * The meeting permissions a quiet instance's test sources stand in for. With the fake
 * capture device nothing touches the real mic; with the helper's file and feed modes
 * nothing touches Core Audio or Accessibility. So macOS has nothing to be asked, and
 * the setup panel must not wait on a grant (or raise a system prompt) for them.
 */
export function standInPermissions(
  env: NodeJS.ProcessEnv,
  hasSwitch: (name: string) => boolean,
): { microphone: boolean; callAudio: boolean; accessibility: boolean } {
  const set = (name: string): boolean => (env[name] ?? '') !== '';
  return {
    microphone: hasSwitch('use-fake-device-for-media-stream'),
    callAudio: set('PATCH_AUDIO_TAP_FILE'),
    accessibility: set('PATCH_AUDIO_SPEAKERS_FEED'),
  };
}
